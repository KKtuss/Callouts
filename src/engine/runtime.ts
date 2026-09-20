import { AxiomCalloutPoller } from "@/engine/axiom-poller"
import { CalloutCollector } from "@/engine/collector"
import { CalloutFeeder } from "@/engine/feeder"
import { MigrationMonitor } from "@/engine/migration-monitor"
import { PumpCalloutPoller } from "@/engine/pump-poller"
import { SnapshotEngine, realClock } from "@/engine/snapshot-engine"
import { DEFAULT_CONFIG, EngineStore } from "@/engine/store"
import { MockTreasury } from "@/engine/treasury"
import type { EngineConfig } from "@/engine/types"
import { DEFAULT_MIGRATION_BONUS, fetchCoinMetadata, isMintAddress, resolveCoinFromEnv } from "@/lib/coin"
import { createBroadcast } from "@/telegram/broadcast"

export type Runtime = {
  engine: SnapshotEngine
  store: EngineStore
  collector: CalloutCollector
  feeder: CalloutFeeder
  pumpPoller: PumpCalloutPoller
  axiomPoller: AxiomCalloutPoller
  migrationMonitor: MigrationMonitor
}

const globalRef = globalThis as typeof globalThis & { __calloutSnap?: Runtime }

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function loadConfig(): EngineConfig {
  const fastStart = process.env.DEMO_FAST_START === "true"
  const coin = resolveCoinFromEnv()
  const liveMint = Boolean(coin.coinMint)
  const axiomCookie = Boolean(process.env.AXIOM_COOKIE?.trim())
  return {
    ...DEFAULT_CONFIG,
    allocationAmount: envNumber("ALLOCATION_AMOUNT", DEFAULT_CONFIG.allocationAmount),
    distributionToken: coin.distributionToken,
    coinMint: coin.coinMint,
    coinName: coin.coinName,
    snapshotMinMs: envNumber("SNAPSHOT_MIN_MS", DEFAULT_CONFIG.snapshotMinMs),
    snapshotMaxMs: envNumber("SNAPSHOT_MAX_MS", DEFAULT_CONFIG.snapshotMaxMs),
    startupSnapshotDelayMs: fastStart
      ? envNumber("STARTUP_SNAPSHOT_DELAY_MS", DEFAULT_CONFIG.startupSnapshotDelayMs ?? 12_000)
      : null,
    feederEnabled: process.env.DEMO_FEED === "true",
    pumpIngestEnabled: process.env.PUMP_INGEST !== "false" && liveMint,
    axiomIngestEnabled: process.env.AXIOM_INGEST !== "false" && liveMint && axiomCookie,
    explorerTxTemplate: process.env.EXPLORER_TX_URL || DEFAULT_CONFIG.explorerTxTemplate,
    explorerAddressTemplate: process.env.EXPLORER_ADDRESS_URL || DEFAULT_CONFIG.explorerAddressTemplate,
    treasuryPublicAddress: process.env.TREASURY_PUBLIC_ADDRESS || DEFAULT_CONFIG.treasuryPublicAddress,
    migrationBonusAmount: envNumber("MIGRATION_BONUS_AMOUNT", DEFAULT_MIGRATION_BONUS),
    migrationMinCallouts: envNumber("MIGRATION_MIN_CALLOUTS", DEFAULT_CONFIG.migrationMinCallouts),
    migrationPollMs: envNumber("MIGRATION_POLL_MS", DEFAULT_CONFIG.migrationPollMs),
  }
}

export function startRuntime(): Runtime {
  const existing = globalRef.__calloutSnap as (Runtime & { axiomPoller?: AxiomCalloutPoller }) | undefined
  // Hot reload can leave a pre-Axiom singleton; rebuild so status always has axiomIngest.
  if (existing?.axiomPoller) return existing
  if (existing) {
    existing.pumpPoller.stop()
    existing.feeder.stop()
    existing.migrationMonitor.stop()
    existing.engine.stop()
    globalRef.__calloutSnap = undefined
  }

  const { preview, broadcast, telegramConnected, channelId } = createBroadcast()
  const collector = new CalloutCollector()
  const config = loadConfig()
  const store = new EngineStore(
    () => collector.all(),
    () => preview.getMessages(),
    config,
  )
  store.telegramConnected = telegramConnected
  store.telegramChannelId = channelId
  store.pumpIngest.enabled = config.pumpIngestEnabled
  store.axiomIngest.enabled = config.axiomIngestEnabled
  store.axiomIngest.cookieConfigured = Boolean(process.env.AXIOM_COOKIE?.trim())

  const treasury = new MockTreasury(
    () => store.config,
    (ms) => realClock.sleep(ms),
    1_000_000_000,
    store.config.treasuryPublicAddress,
  )
  const envKey = process.env.TREASURY_PRIVATE_KEY?.trim()
  if (envKey) {
    treasury.setSecretKey(envKey)
    store.config = {
      ...store.config,
      treasuryPublicAddress: treasury.publicAddress,
    }
  }
  store.treasuryPublicAddress = treasury.publicAddress
  store.treasuryBalance = treasury.balance
  store.treasuryKeyConfigured = treasury.keyConfigured

  const engine = new SnapshotEngine(store, collector, treasury, broadcast, realClock)
  const feeder = new CalloutFeeder(
    (callout) => {
      collector.ingest(callout)
      store.emitState()
    },
    () => store.config,
    undefined,
    () => !store.snapshotInProgress,
  )

  const pollMs = envNumber("PUMP_CALLOUT_POLL_MS", 4_000)
  const pumpPoller = new PumpCalloutPoller(
    (input) => engine.ingestCallout(input),
    () => store.config,
    () => pollMs,
    () => new Date(store.lastSnapshotAt ?? store.startedAt),
    fetch,
    () => store.config.pumpIngestEnabled,
    process.env.PUMP_CALLOUT_API_BASE,
    (status) => {
      store.pumpIngest = status
      store.emitState()
    },
  )

  const axiomPollMs = envNumber("AXIOM_CALLOUT_POLL_MS", 4_000)
  const axiomPoller = new AxiomCalloutPoller(
    (input) => engine.ingestCallout(input),
    () => store.config,
    () => axiomPollMs,
    () => new Date(store.lastSnapshotAt ?? store.startedAt),
    fetch,
    () => store.config.axiomIngestEnabled,
    process.env.AXIOM_CALLOUT_API_BASE,
    (status) => {
      store.axiomIngest = status
      store.emitState()
    },
    process.env.AXIOM_COOKIE ?? "",
  )

  const migrationMonitor = new MigrationMonitor(
    store,
    collector,
    treasury,
    realClock,
    undefined,
    undefined,
    fetch,
    broadcast,
  )

  if (store.config.feederEnabled) {
    for (let i = 0; i < 8; i += 1) {
      feeder.emitOne(new Date(Date.now() - (8 - i) * 1_500))
    }
    feeder.start()
  }

  if (store.config.pumpIngestEnabled) {
    pumpPoller.start()
    store.log("info", `Watching Pump.fun callouts for ${store.config.coinMint}`)
  }

  if (store.config.axiomIngestEnabled) {
    axiomPoller.start()
    store.log("info", `Watching Axiom callouts for ${store.config.coinMint}`)
  }

  migrationMonitor.start()
  engine.start()

  const runtime = { engine, store, collector, feeder, pumpPoller, axiomPoller, migrationMonitor }
  globalRef.__calloutSnap = runtime
  return runtime
}

export function getRuntime(): Runtime {
  return startRuntime()
}

export async function setWatchMint(rawMint: string): Promise<void> {
  const mint = rawMint.trim()
  if (!isMintAddress(mint)) {
    throw new Error("Invalid mint address")
  }

  const runtime = getRuntime()
  const current = runtime.store.config.coinMint
  if (current === mint) return

  const meta = await fetchCoinMetadata(mint)
  // Full board reset: Telegram history, audits, callout pool, poller caches.
  await runtime.engine.resetForMintChange()
  runtime.collector.clear()
  runtime.pumpPoller.reset()
  runtime.axiomPoller?.reset()
  const switchedAt = new Date().toISOString()
  runtime.store.resetHistoryForMint(switchedAt)
  const axiomReady = Boolean(runtime.axiomPoller?.status().cookieConfigured)
  runtime.store.config = {
    ...runtime.store.config,
    coinMint: mint,
    coinName: meta.name,
    distributionToken: meta.ticker,
    pumpIngestEnabled: true,
    axiomIngestEnabled: axiomReady && process.env.AXIOM_INGEST !== "false",
  }
  if (!runtime.store.axiomIngest) {
    runtime.store.axiomIngest = {
      enabled: false,
      connected: false,
      lastPollAt: null,
      lastError: null,
      lastFeedCount: 0,
      accepted: 0,
      skipped: 0,
      cookieConfigured: axiomReady,
    }
  }
  runtime.store.pumpIngest.enabled = true
  runtime.store.axiomIngest.enabled = runtime.store.config.axiomIngestEnabled
  runtime.store.axiomIngest.cookieConfigured = axiomReady
  if (!axiomReady) {
    runtime.store.log(
      "warn",
      "Axiom cookie not set — Pump only sees brand-new home-feed callouts. Paste an Axiom session cookie in Settings for mint-scoped history.",
    )
  } else {
    runtime.store.log("info", `Watching callouts for ${mint}`)
  }
  runtime.store.log("info", "Mint changed — Telegram channel and round history wiped.")
  runtime.pumpPoller.start()
  void runtime.pumpPoller.pollOnce()
  if (runtime.store.config.axiomIngestEnabled && runtime.axiomPoller) {
    runtime.axiomPoller.start()
    void runtime.axiomPoller.pollOnce()
  }
  runtime.migrationMonitor.start()
  runtime.store.emitState()
}

/** Write-only Axiom session cookie. Never echoed in client state. */
export function setAxiomCookie(value: string | null): void {
  const trimmed = typeof value === "string" && value.trim() ? value.trim() : null
  // Keep on process.env so Hot-reload rebuilds of the runtime still authenticate.
  if (trimmed) process.env.AXIOM_COOKIE = trimmed
  else delete process.env.AXIOM_COOKIE

  const runtime = getRuntime()
  if (!runtime.axiomPoller) {
    throw new Error("Axiom poller unavailable — restart the server")
  }
  runtime.axiomPoller.setCookie(trimmed)
  const configured = runtime.axiomPoller.status().cookieConfigured
  if (!runtime.store.axiomIngest) {
    runtime.store.axiomIngest = {
      enabled: false,
      connected: false,
      lastPollAt: null,
      lastError: null,
      lastFeedCount: 0,
      accepted: 0,
      skipped: 0,
      cookieConfigured: configured,
    }
  }
  runtime.store.axiomIngest.cookieConfigured = configured
  runtime.store.config = {
    ...runtime.store.config,
    axiomIngestEnabled:
      configured && Boolean(runtime.store.config.coinMint) && process.env.AXIOM_INGEST !== "false",
  }
  runtime.store.axiomIngest.enabled = runtime.store.config.axiomIngestEnabled
  if (runtime.store.config.axiomIngestEnabled) {
    runtime.axiomPoller.start()
    void runtime.axiomPoller.pollOnce()
    runtime.store.log("info", "Axiom cookie updated — polling callouts")
  } else {
    runtime.store.emitState()
  }
}
