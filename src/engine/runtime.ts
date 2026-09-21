import { AxiomCalloutPoller } from "@/engine/axiom-poller"
import { CalloutCollector } from "@/engine/collector"
import {
  decryptTreasuryKey,
  encryptTreasuryKey,
  loadDurableConfig,
  saveDurableConfig,
} from "@/engine/durable-config"
import { CalloutFeeder } from "@/engine/feeder"
import { FomoThesesPoller } from "@/engine/fomo-poller"
import { MigrationMonitor } from "@/engine/migration-monitor"
import { PumpCalloutPoller } from "@/engine/pump-poller"
import { SnapshotEngine, realClock } from "@/engine/snapshot-engine"
import { DEFAULT_CONFIG, EngineStore } from "@/engine/store"
import { SolanaTreasury } from "@/engine/solana-treasury"
import type { Treasury } from "@/engine/treasury"
import type { EngineConfig } from "@/engine/types"
import {
  DEFAULT_MIGRATION_BONUS,
  fetchCoinBondingStatus,
  fetchCoinMetadata,
  isMintAddress,
  resolveCoinFromEnv,
} from "@/lib/coin"
import {
  clearPinCache,
  expandCallouts,
  readMintFromPinnedIntro,
  loadPersistedWatch,
  readPersistedWatch,
  readQualifiedBoardFromPin,
  persistWatch,
  clearPersistedWatch,
  type PersistedCaller,
} from "@/engine/persist-watch"
import { createBroadcast } from "@/telegram/broadcast"
import { bumpEpoch, claimLeadership, localEpochNow, noteEpoch, readEpoch, touchLeaderWork } from "@/engine/watch-kv"
import { after } from "next/server"

export type Runtime = {
  engine: SnapshotEngine
  store: EngineStore
  collector: CalloutCollector
  feeder: CalloutFeeder
  pumpPoller: PumpCalloutPoller
  axiomPoller: AxiomCalloutPoller
  fomoPoller: FomoThesesPoller
  migrationMonitor: MigrationMonitor
}

const globalRef = globalThis as typeof globalThis & {
  __calloutSnap?: Runtime
  __calloutHydrate?: Promise<void>
}

const pinMismatchLogged = new WeakMap<EngineStore, string>()
const pinIntroRefreshStarted = new WeakSet<EngineStore>()

function notePinMintMismatch(runtime: Runtime, pinMint: string | null, mint: string | null) {
  const key = `${pinMint ?? "none"}≠${mint ?? "none"}`
  if (pinMismatchLogged.get(runtime.store) !== key) {
    pinMismatchLogged.set(runtime.store, key)
    runtime.store.log(
      "info",
      `[wallet] Pin mint ${pinMint ?? "none"} ≠ ${mint ?? "none"} — starting a fresh window`,
    )
  }
  // Waiting pin is source of truth. Never stamp a previous test mint back onto it.
  if (!pinMint && mint) {
    void parkIsolateIdle(runtime, mint)
    return
  }
  if (!mint || pinIntroRefreshStarted.has(runtime.store)) return
  pinIntroRefreshStarted.add(runtime.store)
  void runtime.engine.publishChannelIntro(false).then(() => {
    clearPinCache()
  })
}

async function parkIsolateIdle(runtime: Runtime, previousMint?: string | null) {
  const abandoned = previousMint ?? runtime.store.config.coinMint
  delete process.env.CALLOUT_MINT
  process.env.CALLOUT_TOKEN = "SHILL"
  process.env.DISTRIBUTION_TOKEN = "SHILL"
  process.env.CALLOUT_NAME = "SHILL"
  runtime.store.config = {
    ...runtime.store.config,
    coinMint: null,
    coinName: null,
    distributionToken: "SHILL",
    pumpIngestEnabled: false,
    axiomIngestEnabled: false,
  }
  runtime.store.pumpIngest.enabled = false
  runtime.store.axiomIngest.enabled = false
  runtime.store.schedulerPaused = true
  runtime.store.nextSnapshotAt = null
  runtime.pumpPoller.stop()
  runtime.axiomPoller?.stop()
  runtime.fomoPoller?.stop()
  runtime.migrationMonitor.stop()
  runtime.collector.clear()
  runtime.store.resetHistoryForMint()
  runtime.store.schedulerPaused = true
  runtime.store.nextSnapshotAt = null
  await clearPersistedWatch(abandoned)
  runtime.store.log("info", "Pin is waiting — this isolate dropped the previous mint.")
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function loadConfig(): EngineConfig {
  const fastStart = process.env.DEMO_FAST_START === "true"
  const coin = resolveCoinFromEnv()
  const coinMint = coin.coinMint
  const distributionToken = coin.distributionToken
  const coinName = coin.coinName
  const liveMint = Boolean(coinMint)
  const axiomCookie = Boolean(process.env.AXIOM_COOKIE?.trim())
  return {
    ...DEFAULT_CONFIG,
    allocationAmount: envNumber("ALLOCATION_AMOUNT", DEFAULT_CONFIG.allocationAmount),
    distributionToken,
    coinMint,
    coinName,
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
    migrationWinnerCount: envNumber("MIGRATION_WINNER_COUNT", DEFAULT_CONFIG.migrationWinnerCount),
    migrationMinCallouts: envNumber("MIGRATION_MIN_CALLOUTS", DEFAULT_CONFIG.migrationMinCallouts),
    migrationPollMs: envNumber("MIGRATION_POLL_MS", DEFAULT_CONFIG.migrationPollMs),
    creatorRewardShareBps: envNumber("CREATOR_REWARD_SHARE_BPS", DEFAULT_CONFIG.creatorRewardShareBps),
    fomoTreasuryWallet: process.env.FOMO_TREASURY_WALLET?.trim() || null,
  }
}

export function startRuntime(): Runtime {
  const existing = globalRef.__calloutSnap as
    | (Runtime & { axiomPoller?: AxiomCalloutPoller; fomoPoller?: FomoThesesPoller })
    | undefined
  // Hot reload can leave a pre-Axiom/FOMO singleton; rebuild so pollers are present.
  if (existing?.axiomPoller && existing?.fomoPoller) return existing
  if (existing) {
    existing.pumpPoller.stop()
    existing.feeder.stop()
    existing.axiomPoller?.stop()
    existing.fomoPoller?.stop()
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
  const persistedLedger = readPersistedWatch()
  if (persistedLedger && persistedLedger.mint === store.config.coinMint) {
    if (persistedLedger.wipedAt) {
      store.dropHistoryAtOrBefore(persistedLedger.wipedAt)
      store.watchStartedAt = persistedLedger.wipedAt
    }
    store.hydrateLedger(persistedLedger.lastSnapshotAt ?? null, persistedLedger.rounds ?? [])
    store.hydrateScheduler(
      persistedLedger.nextSnapshotAt ?? null,
      persistedLedger.schedulerPaused ? true : null,
    )
    store.hydrateMigration(persistedLedger.migrationPaid === true)
    if (persistedLedger.lifetimeCallouts?.length) {
      store.hydrateLifetimeCallouts(
        expandCallouts(persistedLedger.lifetimeCallouts, store.config.distributionToken, store.config.coinMint),
      )
    }
    if (store.lastSnapshotAt) collector.dropAtOrBefore(store.lastSnapshotAt)
    hydrateCollectorCallouts(
      collector,
      store.config.distributionToken,
      persistedLedger.callouts,
      store.windowStartIso(),
      store.config.coinMint,
    )
    collector.dropMatching(
      (row) =>
        Boolean(row.mint && store.config.coinMint && row.mint !== store.config.coinMint) ||
        (!row.mint && row.id.startsWith("fomo_family_")),
    )
  }

  const envKey = process.env.TREASURY_PRIVATE_KEY?.trim()
  const treasury: Treasury = new SolanaTreasury(
    () => store.config,
    (ms) => realClock.sleep(ms),
    process.env.SOLANA_RPC_URL?.trim() || undefined,
    store.config.treasuryPublicAddress,
  )
  if (envKey) {
    treasury.setSecretKey(envKey)
    store.config = {
      ...store.config,
      treasuryPublicAddress: treasury.publicAddress,
    }
  }
  store.treasuryPublicAddress = treasury.publicAddress
  store.treasuryKeyConfigured = treasury.keyConfigured
  store.treasuryBalance = treasury.balance
  void treasury.refreshBalance().then((balance) => {
    store.treasuryBalance = balance
    store.emitState()
  })

  const engine = new SnapshotEngine(store, collector, treasury, broadcast, realClock)
  const persistWatch = () => engine.persistWatchState()
  const feeder = new CalloutFeeder(
    (callout) => {
      collector.ingest(callout)
      store.emitState()
    },
    () => store.config,
    undefined,
    () => !store.snapshotInProgress,
  )

  const pollMs = envNumber("PUMP_CALLOUT_POLL_MS", 1_000)
  const pumpPoller = new PumpCalloutPoller(
    (input) => engine.ingestCallout(input),
    () => store.config,
    () => pollMs,
    () => new Date(store.windowStartIso()),
    fetch,
    () => store.config.pumpIngestEnabled,
    process.env.PUMP_CALLOUT_API_BASE,
    (status) => {
      store.pumpIngest = status
      store.emitState()
    },
    () => false,
    () => engine.syncQualifiedBoard(),
  )

  const axiomPollMs = envNumber("AXIOM_CALLOUT_POLL_MS", 1_000)
  const axiomPoller = new AxiomCalloutPoller(
    (input) => engine.ingestCallout(input),
    () => store.config,
    () => axiomPollMs,
    () => new Date(store.windowStartIso()),
    fetch,
    () => store.config.axiomIngestEnabled,
    process.env.AXIOM_CALLOUT_API_BASE,
    (status) => {
      store.axiomIngest = status
      store.emitState()
    },
    process.env.AXIOM_COOKIE ?? "",
  )

  const fomoPollMs = envNumber("FOMO_THESIS_POLL_MS", 20_000)
  // Theses come from the opened fomo.family window (scripts/watch-fomo-browser.mjs).
  // Do not open fomoapi from the server.
  const fomoEnabled = () => false
  const fomoPoller = new FomoThesesPoller(
    (input) => engine.ingestCallout(input),
    () => store.config,
    () => fomoPollMs,
    () => new Date(store.windowStartIso()),
    fetch,
    fomoEnabled,
    process.env.FOMO_API_BASE,
    (status) => {
      store.fomoIngest = status
      store.emitState()
      if (status.lastError) {
        store.log("warn", `[fomo] ${status.lastError}`)
      }
      const tag = `[fomo] accepted=${status.accepted} feed=${status.lastFeedCount} unresolved=${status.unresolved} err=${status.lastError ?? "none"}`
      store.log("info", tag)
    },
    "",
    undefined,
    // Wallet REST is 2,500 credits — only when explicitly enabled with budget.
    process.env.FOMO_PAID_WALLET_RESOLVE === "true",
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
    persistWatch,
  )

  if (store.config.feederEnabled) {
    for (let i = 0; i < 8; i += 1) {
      feeder.emitOne(new Date(Date.now() - (8 - i) * 1_500))
    }
    feeder.start()
  }

  if (store.config.pumpIngestEnabled) {
    store.log("info", `Watching Pump.fun callouts for ${store.config.coinMint}`)
  }

  if (store.config.axiomIngestEnabled) {
    store.log("info", `Watching Axiom callouts for ${store.config.coinMint}`)
  }

  if (store.config.coinMint) {
    store.log("info", `FOMO theses come from the opened fomo.family window for ${store.config.coinMint}`)
  }

  engine.start()

  const runtime = {
    engine,
    store,
    collector,
    feeder,
    pumpPoller,
    axiomPoller,
    fomoPoller,
    migrationMonitor,
  }
  globalRef.__calloutSnap = runtime
  return runtime
}

export function getRuntime(): Runtime {
  const runtime = startRuntime()
  globalRef.__calloutHydrate ??= bootstrapRuntime(runtime)
  return runtime
}

function standDown(runtime: Runtime) {
  runtime.engine.stop()
  runtime.pumpPoller.stop()
  runtime.axiomPoller?.stop()
  runtime.fomoPoller?.stop()
  runtime.migrationMonitor.stop()
}

/** Adopt the Redis generation. A copy that already ran an older one drops its memory. */
async function syncEpoch(runtime: Runtime) {
  const epoch = await readEpoch()
  const local = localEpochNow()
  if (epoch === local) return
  const hadHistory =
    runtime.store.listAudits().length > 0 ||
    runtime.collector.all().length > 0 ||
    Boolean(runtime.store.lastSnapshotAt)
  const stale = local !== 0 || hadHistory
  noteEpoch(epoch)
  if (!stale) return
  standDown(runtime)
  runtime.engine.discardStaleBoard()
  runtime.collector.clear()
  runtime.store.resetHistoryForMint()
  runtime.store.log("info", `Generation ${epoch} — dropped this copy's old history`)
}

export async function waitForRuntime(): Promise<Runtime> {
  const runtime = getRuntime()
  if (globalRef.__calloutHydrate) await globalRef.__calloutHydrate
  await followDurableMint(runtime)
  await syncEpoch(runtime)
  if (!runtime.store.config.coinMint) {
    runtime.store.schedulerPaused = true
    runtime.store.nextSnapshotAt = null
    standDown(runtime)
    runtime.store.emitState()
    return runtime
  }
  const leader = await claimLeadership()
  if (runtime.store.config.coinMint) await hydrateSnapshotLedger(runtime)
  if (!leader) {
    standDown(runtime)
    return runtime
  }
  await refreshLive(runtime)
  scheduleCatchUp(runtime)
  return runtime
}

/**
 * Run a due snapshot after the HTTP response. Vercel freezes setTimeout when
 * the isolate sleeps; `after()` keeps the work alive so the OPS countdown
 * actually fires.
 */
function scheduleCatchUp(runtime: Runtime) {
  const next = runtime.store.nextSnapshotAt ? Date.parse(runtime.store.nextSnapshotAt) : NaN
  const dueIn = Number.isFinite(next) ? next - Date.now() : 0
  // Don't spawn catch-up work on every OPS poll while the published
  // countdown is still minutes away — that was re-arming 5-minute timers.
  if (dueIn > 20_000) return
  const run = () =>
    runtime.engine.catchUp().catch((error) => {
      runtime.store.log(
        "error",
        error instanceof Error ? error.message : "Scheduler catch-up failed",
      )
    })
  try {
    after(run)
  } catch {
    setTimeout(() => void run(), 0)
  }
}

async function refreshLive(runtime: Runtime) {
  if (!runtime.store.config.coinMint) {
    await hydrateWatchFromPin(runtime)
  }
  const mint = runtime.store.config.coinMint
  if (!mint) return
  await hydrateSnapshotLedger(runtime)
  restoreScheduler(runtime)
  try {
    await runtime.migrationMonitor.pollOnce()
  } catch (error) {
    runtime.store.migrationLastError =
      error instanceof Error ? error.message : "Migration poll failed"
    runtime.store.emitState()
  }
  if (!runtime.store.migrationPaid) runtime.migrationMonitor.start()
  if (runtime.store.config.pumpIngestEnabled) {
    runtime.pumpPoller.start()
    try {
      await runtime.pumpPoller.pollOnce()
    } catch (error) {
      runtime.store.log(
        "warn",
        `[wallet] Pump poll failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (runtime.store.config.axiomIngestEnabled && runtime.axiomPoller) {
    runtime.axiomPoller.start()
    try {
      await runtime.axiomPoller.pollOnce()
    } catch {
      /* status already recorded */
    }
  }
  runtime.fomoPoller?.stop()
  await runtime.engine.syncQualifiedBoard()
  await touchLeaderWork()
}

/**
 * Pull operational config from Redis and apply it to the in-memory store.
 * Fields in durable config win over Vercel env var defaults; the admin UI
 * sets both so they stay in sync. The treasury private key is stored
 * AES-256-GCM encrypted (ADMIN_KEY is the KDF input).
 */
/** Redis mint wins over the Vercel env mint, so a start or stop reaches every isolate. */
async function followDurableMint(runtime: Runtime) {
  const cfg = await loadDurableConfig()
  if (!cfg || !Object.prototype.hasOwnProperty.call(cfg, "coinMint")) return
  const minted = typeof cfg.coinMint === "string" && isMintAddress(cfg.coinMint) ? cfg.coinMint : null
  if (minted) applyLiveMint(runtime, minted, cfg.distributionToken ?? null, cfg.coinName ?? null)
  else applyIdleMint(runtime)
}

function applyLiveMint(
  runtime: Runtime,
  mint: string,
  ticker: string | null,
  name: string | null,
) {
  if (runtime.store.config.coinMint === mint) return
  process.env.CALLOUT_MINT = mint
  if (ticker) {
    process.env.CALLOUT_TOKEN = ticker
    process.env.DISTRIBUTION_TOKEN = ticker
  }
  if (name) process.env.CALLOUT_NAME = name
  runtime.store.config = {
    ...runtime.store.config,
    coinMint: mint,
    coinName: name,
    distributionToken: ticker || runtime.store.config.distributionToken,
    pumpIngestEnabled: process.env.PUMP_INGEST !== "false",
    axiomIngestEnabled:
      Boolean(runtime.axiomPoller?.status().cookieConfigured) && process.env.AXIOM_INGEST !== "false",
  }
  runtime.store.pumpIngest.enabled = runtime.store.config.pumpIngestEnabled
  if (runtime.store.axiomIngest) runtime.store.axiomIngest.enabled = runtime.store.config.axiomIngestEnabled
  runtime.collector.clear()
  runtime.pumpPoller.reset()
  runtime.axiomPoller?.reset()
  runtime.fomoPoller?.reset()
  runtime.store.resetHistoryForMint()
  runtime.store.log("info", `Live mint is ${ticker || mint}`)
}

function applyIdleMint(runtime: Runtime) {
  delete process.env.CALLOUT_MINT
  delete process.env.CALLOUT_TOKEN
  delete process.env.CALLOUT_NAME
  delete process.env.DISTRIBUTION_TOKEN
  const hadMint = Boolean(runtime.store.config.coinMint)
  runtime.store.config = {
    ...runtime.store.config,
    coinMint: null,
    coinName: null,
    distributionToken: "SHILL",
    pumpIngestEnabled: false,
    axiomIngestEnabled: false,
  }
  runtime.store.pumpIngest.enabled = false
  if (runtime.store.axiomIngest) runtime.store.axiomIngest.enabled = false
  runtime.store.schedulerPaused = true
  runtime.store.nextSnapshotAt = null
  if (!hadMint) return
  runtime.pumpPoller.stop()
  runtime.pumpPoller.reset()
  runtime.axiomPoller?.stop()
  runtime.axiomPoller?.reset()
  runtime.fomoPoller?.stop()
  runtime.fomoPoller?.reset()
  runtime.migrationMonitor.stop()
  runtime.collector.clear()
  runtime.store.resetHistoryForMint()
  runtime.store.schedulerPaused = true
  runtime.store.nextSnapshotAt = null
}

async function applyDurableConfig(runtime: Runtime) {
  const cfg = await loadDurableConfig()
  if (!cfg) return

  const patch: Partial<EngineConfig> = {}
  if (cfg.fomoTreasuryWallet !== null && cfg.fomoTreasuryWallet !== undefined) {
    patch.fomoTreasuryWallet = cfg.fomoTreasuryWallet
  }
  if (cfg.snapshotMinMs !== null && cfg.snapshotMinMs !== undefined) {
    patch.snapshotMinMs = cfg.snapshotMinMs
  }
  if (cfg.snapshotMaxMs !== null && cfg.snapshotMaxMs !== undefined) {
    patch.snapshotMaxMs = cfg.snapshotMaxMs
  }
  if (cfg.allocationAmount !== null && cfg.allocationAmount !== undefined) {
    patch.allocationAmount = cfg.allocationAmount
  }
  if (cfg.creatorRewardShareBps !== null && cfg.creatorRewardShareBps !== undefined) {
    patch.creatorRewardShareBps = cfg.creatorRewardShareBps
  }
  if (cfg.treasuryPublicAddress) {
    patch.treasuryPublicAddress = cfg.treasuryPublicAddress
  }
  if (Object.prototype.hasOwnProperty.call(cfg, "coinMint")) {
    const minted = typeof cfg.coinMint === "string" && isMintAddress(cfg.coinMint) ? cfg.coinMint : null
    if (minted) {
      applyLiveMint(runtime, minted, cfg.distributionToken ?? null, cfg.coinName ?? null)
    } else {
      applyIdleMint(runtime)
    }
  }

  if (Object.keys(patch).length > 0) {
    runtime.store.config = { ...runtime.store.config, ...patch }
  }

  // Decrypt and load treasury key if stored.
  if (cfg.encryptedTreasuryKey) {
    const adminKey = process.env.ADMIN_KEY?.trim()
    if (adminKey) {
      const raw = decryptTreasuryKey(cfg.encryptedTreasuryKey, adminKey)
      if (raw) {
        runtime.engine.setTreasuryPrivateKey(raw)
        runtime.store.config = {
          ...runtime.store.config,
          treasuryPublicAddress: runtime.store.treasuryPublicAddress,
        }
      }
    }
  }
}

function pinMatchesGeneration(pin: { generation?: number | null }): boolean {
  const epoch = localEpochNow()
  if (epoch <= 0) return true
  return pin.generation === epoch
}

function isAfterWipe(iso: string | null | undefined, wipedAt: string | null | undefined): boolean {
  if (!iso) return false
  if (!wipedAt) return true
  const t = Date.parse(iso)
  const w = Date.parse(wipedAt)
  return Number.isFinite(t) && Number.isFinite(w) && t > w
}

async function bootstrapRuntime(runtime: Runtime) {
  // ── Durable config: load persisted operational settings from Redis ──
  // This runs before pin hydration so every cold-start isolate picks up the
  // latest fomoTreasuryWallet, snapshot timing, treasury key, etc. without
  // requiring a Vercel redeploy.
  await applyDurableConfig(runtime)
  await syncEpoch(runtime)
  const leader = await claimLeadership()

  if (!runtime.store.config.coinMint) {
    await hydrateWatchFromPin(runtime)
  }
  const ledger = await hydrateSnapshotLedger(runtime)
  const mint = runtime.store.config.coinMint
  if (!mint) {
    runtime.store.schedulerPaused = true
    runtime.store.nextSnapshotAt = null
    runtime.store.log("info", "Waiting for SHILL tech — no mint configured.")
    // Do not rewrite the pin here. Cold isolates with empty CALLOUT_MINT would
    // stamp the waiting banner over a live mint. enterIdle() owns that publish.
    runtime.store.emitState()
    return
  }
  if (!leader) {
    standDown(runtime)
    runtime.store.emitState()
    return
  }
  if (runtime.store.config.pumpIngestEnabled) {
    runtime.pumpPoller.start()
    try {
      await runtime.pumpPoller.pollOnce()
      const p = runtime.store.pumpIngest
      runtime.store.log(
        "info",
        `[wallet] Pump poll: accepted=${p.accepted} skipped=${p.skipped} feed=${p.lastFeedCount} err=${p.lastError ?? "none"}`,
      )
    } catch (error) {
      runtime.store.log(
        "warn",
        `[wallet] Pump poll failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (runtime.store.config.axiomIngestEnabled && runtime.axiomPoller) {
    runtime.axiomPoller.start()
    try {
      await runtime.axiomPoller.pollOnce()
    } catch {
      /* status already recorded */
    }
  }
  runtime.fomoPoller?.stop()
  restoreScheduler(runtime)
  const pinHasSchedule =
    ledger.sameMint &&
    (Boolean(ledger.pin?.nextSnapshotAt) ||
      ledger.pin?.schedulerPaused === true ||
      ledger.pin?.schedulerPaused === false)
  if (!pinHasSchedule) {
    await runtime.engine.publishChannelIntro(false)
  }
  await runtime.engine.syncQualifiedBoard()
  await touchLeaderWork()
  runtime.store.emitState()
}

async function hydrateSnapshotLedger(runtime: Runtime) {
  const mint = runtime.store.config.coinMint
  const persisted = await loadPersistedWatch(mint)
  if (persisted?.wipedAt) {
    runtime.store.dropHistoryAtOrBefore(persisted.wipedAt)
    runtime.store.watchStartedAt = persisted.wipedAt
  }
  if (persisted && persisted.mint === mint) {
    runtime.store.hydrateLedger(persisted.lastSnapshotAt ?? null, persisted.rounds ?? [])
    runtime.store.hydrateScheduler(
      persisted.nextSnapshotAt ?? null,
      persisted.schedulerPaused ? true : null,
    )
    runtime.store.hydrateMigration(persisted.migrationPaid === true)
    if (persisted.migrationSawOpen) runtime.store.migrationSawOpen = true
    if (persisted.lifetimeCallouts?.length) {
      runtime.store.hydrateLifetimeCallouts(
        expandCallouts(persisted.lifetimeCallouts, runtime.store.config.distributionToken, runtime.store.config.coinMint),
      )
    }
  }
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHANNEL_ID?.trim()
  let pin: Awaited<ReturnType<typeof readQualifiedBoardFromPin>> | null = null
  let pinMint: string | null = null
  if (token && chatId) {
    pin = await readQualifiedBoardFromPin(token, chatId)
    pinMint = await readMintFromPinnedIntro(token, chatId, mint)
    const sameMint = Boolean(mint && pinMint && pinMint === mint)
    if (sameMint && pin && pinMatchesGeneration(pin)) {
      const wipe = persisted?.wipedAt ?? null
      const pinLast = isAfterWipe(pin.lastSnapshotAt, wipe) ? pin.lastSnapshotAt : null
      const pinRounds = (pin.rounds ?? []).filter((round) => isAfterWipe(round.at, wipe))
      // Redis/file rounds win; pin only fills gaps (often ≤1 round).
      if (!persisted?.rounds?.length) {
        runtime.store.hydrateLedger(pinLast, pinRounds)
      } else if (pinLast) {
        runtime.store.hydrateLedger(pinLast, [])
      }
      if (isAfterWipe(pin.nextSnapshotAt, wipe) || pin.schedulerPaused === true) {
        runtime.store.hydrateScheduler(
          isAfterWipe(pin.nextSnapshotAt, wipe) ? pin.nextSnapshotAt : null,
          pin.schedulerPaused,
        )
      }
      runtime.store.hydrateMigration(pin.migrationPaid)
    } else if (!sameMint) {
      notePinMintMismatch(runtime, pinMint, mint)
    }
  }
  if (persisted?.wipedAt) {
    runtime.store.dropHistoryAtOrBefore(persisted.wipedAt)
    runtime.store.watchStartedAt = persisted.wipedAt
    if (
      runtime.store.nextSnapshotAt &&
      !isAfterWipe(runtime.store.nextSnapshotAt, persisted.wipedAt)
    ) {
      runtime.store.nextSnapshotAt = null
    }
  }
  if (runtime.store.lastSnapshotAt) {
    runtime.collector.dropAtOrBefore(runtime.store.lastSnapshotAt)
  }
  const windowStart = runtime.store.windowStartIso()
  if (persisted && persisted.mint === mint) {
    hydrateCollectorCallouts(
      runtime.collector,
      runtime.store.config.distributionToken,
      persisted.callouts,
      windowStart,
      mint,
    )
  }
  if (pin && mint && pinMint === mint && pinMatchesGeneration(pin)) {
    hydrateCollectorCallouts(
      runtime.collector,
      runtime.store.config.distributionToken,
      pin.callouts,
      windowStart,
      mint,
    )
  }
  runtime.collector.dropMatching(
    (row) => Boolean(row.mint && mint && row.mint !== mint) || (!row.mint && row.id.startsWith("fomo_family_")),
  )
  if (persisted?.wipedAt) runtime.collector.dropAtOrBefore(persisted.wipedAt)
  dropDeadDeadline(runtime)
  return { pin, sameMint: Boolean(mint && pinMint && pinMint === mint) }
}

/** A deadline in the past is not a schedule. The leader arms a new 5–15 minute window. */
function dropDeadDeadline(runtime: Runtime) {
  const next = runtime.store.nextSnapshotAt ? Date.parse(runtime.store.nextSnapshotAt) : NaN
  if (Number.isFinite(next) && next <= Date.now()) runtime.store.nextSnapshotAt = null
}

function hydrateCollectorCallouts(
  collector: CalloutCollector,
  token: string,
  rows: PersistedCaller[] | undefined,
  windowStartIso: string,
  mint?: string | null,
) {
  if (!rows?.length) return
  collector.merge(expandCallouts(rows, token, mint), new Date(windowStartIso))
}

function restoreScheduler(runtime: Runtime) {
  if (runtime.store.snapshotInProgress) return
  if (!runtime.store.config.coinMint || !runtime.store.treasuryKeyConfigured) return
  if (runtime.store.schedulerPaused) {
    runtime.engine.pause()
    return
  }
  dropDeadDeadline(runtime)
  if (runtime.store.nextSnapshotAt) {
    runtime.engine.restoreDeadline(runtime.store.nextSnapshotAt)
    return
  }
  runtime.engine.rearmScheduler()
}

async function hydrateWatchFromPin(runtime: Runtime) {
  if (runtime.store.config.coinMint) return
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHANNEL_ID?.trim()
  if (!token || !chatId) return
  const mint = await readMintFromPinnedIntro(token, chatId)
  if (!mint || !isMintAddress(mint)) {
    runtime.store.log("warn", "[wallet] Pinned intro has no mint URL — save the mint in /ops once.")
    return
  }
  try {
    const meta = await fetchCoinMetadata(mint)
    await persistWatch({ mint, ticker: meta.ticker, name: meta.name })
    const axiomReady = Boolean(runtime.axiomPoller?.status().cookieConfigured)
    runtime.store.config = {
      ...runtime.store.config,
      coinMint: mint,
      coinName: meta.name,
      distributionToken: meta.ticker,
      pumpIngestEnabled: process.env.PUMP_INGEST !== "false",
      axiomIngestEnabled: axiomReady && process.env.AXIOM_INGEST !== "false",
    }
    runtime.store.pumpIngest.enabled = runtime.store.config.pumpIngestEnabled
    runtime.store.axiomIngest.enabled = runtime.store.config.axiomIngestEnabled
    runtime.store.log(
      "info",
      `[wallet] Restored mint from pinned intro → ${meta.ticker} (${mint})`,
    )
  } catch (error) {
    runtime.store.log(
      "warn",
      `[wallet] Failed to restore mint from pin: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function setWatchMint(rawMint: string): Promise<void> {
  const mint = rawMint.trim()
  if (!isMintAddress(mint)) {
    throw new Error("Invalid mint address")
  }

  const runtime = await waitForRuntime()
  if (!runtime.store.treasuryKeyConfigured) {
    throw new Error("Set the treasury private key before starting a mint. Start is mint + treasury, then Pump, FOMO, and payouts arm together.")
  }
  const current = runtime.store.config.coinMint
  const wipedAt = new Date().toISOString()
  // Bump before any clear so other copies cannot write the old ledger back.
  await bumpEpoch({ mints: [current, mint] })
  await claimLeadership()
  if (current && current !== mint) await clearPersistedWatch(current)

  const meta = await fetchCoinMetadata(mint)
  process.env.CALLOUT_MINT = mint
  process.env.CALLOUT_TOKEN = meta.ticker
  process.env.DISTRIBUTION_TOKEN = meta.ticker
  if (meta.name) process.env.CALLOUT_NAME = meta.name

  runtime.store.config = {
    ...runtime.store.config,
    coinMint: mint,
    coinName: meta.name,
    distributionToken: meta.ticker,
    pumpIngestEnabled: process.env.PUMP_INGEST !== "false",
    axiomIngestEnabled:
      Boolean(runtime.axiomPoller?.status().cookieConfigured) && process.env.AXIOM_INGEST !== "false",
  }
  await persistWatch({
    mint,
    ticker: meta.ticker,
    name: meta.name,
    rounds: [],
    callouts: [],
    lifetimeCallouts: [],
    lastSnapshotAt: null,
    nextSnapshotAt: null,
    migrationPaid: false,
    migrationSawOpen: false,
    schedulerPaused: false,
    wipedAt,
  })
  await saveDurableConfig({
    coinMint: mint,
    coinName: meta.name,
    distributionToken: meta.ticker,
  })

  const fromIdle = !current
  if (fromIdle) {
    await runtime.engine.launchFromIdle()
  } else {
    // Full board reset: Telegram history, audits, callout pool, poller caches.
    await runtime.engine.resetForMintChange()
  }
  runtime.collector.clear()
  runtime.pumpPoller.reset()
  runtime.axiomPoller?.reset()
  runtime.fomoPoller?.reset()
  const switchedAt = new Date().toISOString()
  runtime.store.resetHistoryForMint(switchedAt)
  const axiomReady = Boolean(runtime.axiomPoller?.status().cookieConfigured)
  runtime.store.config = {
    ...runtime.store.config,
    coinMint: mint,
    coinName: meta.name,
    distributionToken: meta.ticker,
    pumpIngestEnabled: process.env.PUMP_INGEST !== "false",
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
  runtime.store.pumpIngest.enabled = runtime.store.config.pumpIngestEnabled
  runtime.store.axiomIngest.enabled = runtime.store.config.axiomIngestEnabled
  runtime.store.axiomIngest.cookieConfigured = axiomReady
  let alreadyBonded = false
  try {
    alreadyBonded = (await fetchCoinBondingStatus(mint)).migrated
  } catch (error) {
    runtime.store.log(
      "warn",
      `[wallet] Bonding check failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (alreadyBonded) {
    runtime.store.migrationBonded = true
    runtime.store.migrationPaid = true
    runtime.store.migrationSawOpen = false
    await persistWatch({
      mint,
      ticker: meta.ticker,
      name: meta.name,
      migrationPaid: true,
      migrationSawOpen: false,
      wipedAt,
    })
    runtime.store.log("info", "Already bonded — lottery settled without a channel post")
  }
  runtime.engine.rearmScheduler()
  await runtime.engine.publishChannelIntro(true)
  runtime.store.log(
    "info",
    `[wallet] Mint set → ${meta.ticker} (${mint}) | pump=${runtime.store.config.pumpIngestEnabled} | axiom=${runtime.store.config.axiomIngestEnabled} | fomo=window`,
  )
  if (!axiomReady) {
    runtime.store.log(
      "warn",
      "Axiom cookie not set — Pump only sees brand-new home-feed callouts. Paste an Axiom session cookie in Settings for mint-scoped history.",
    )
  }
  runtime.store.log(
    "info",
    fromIdle
      ? `[wallet] Mint launched → ${meta.ticker} (${mint}) | pump=${runtime.store.config.pumpIngestEnabled} | axiom=${runtime.store.config.axiomIngestEnabled} | fomo=window`
      : "Mint changed — Telegram channel and round history wiped.",
  )
  runtime.pumpPoller.start()
  try {
    await runtime.pumpPoller.pollOnce()
    const p = runtime.store.pumpIngest
    runtime.store.log(
      "info",
      `[wallet] Pump poll: accepted=${p.accepted} skipped=${p.skipped} feed=${p.lastFeedCount} err=${p.lastError ?? "none"}`,
    )
  } catch (error) {
    runtime.store.log(
      "warn",
      `[wallet] Pump poll failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (runtime.store.config.axiomIngestEnabled && runtime.axiomPoller) {
    runtime.axiomPoller.start()
    void runtime.axiomPoller.pollOnce()
  }
  runtime.fomoPoller?.stop()
  runtime.migrationMonitor.start()
  await runtime.engine.syncQualifiedBoard()
  runtime.store.emitState()
}

export async function clearWatchMint(): Promise<void> {
  const runtime = await waitForRuntime()
  const abandoned = runtime.store.config.coinMint
  const hadMint = Boolean(abandoned)
  await bumpEpoch({ mints: [abandoned] })
  await claimLeadership()
  delete process.env.CALLOUT_MINT
  process.env.CALLOUT_TOKEN = "SHILL"
  process.env.DISTRIBUTION_TOKEN = "SHILL"
  process.env.CALLOUT_NAME = "SHILL"

  runtime.store.config = {
    ...runtime.store.config,
    coinMint: null,
    coinName: null,
    distributionToken: "SHILL",
    pumpIngestEnabled: false,
    axiomIngestEnabled: false,
  }
  runtime.store.pumpIngest.enabled = false
  runtime.store.axiomIngest.enabled = false
  await clearPersistedWatch(abandoned)
  await saveDurableConfig({
    coinMint: null,
    coinName: null,
    distributionToken: "SHILL",
  })
  runtime.pumpPoller.stop()
  runtime.pumpPoller.reset()
  runtime.axiomPoller?.stop()
  runtime.axiomPoller?.reset()
  runtime.fomoPoller?.stop()
  runtime.fomoPoller?.reset()
  runtime.migrationMonitor.stop()
  runtime.collector.clear()
  await runtime.engine.enterIdle({ purgeTelegram: hadMint })
  runtime.store.emitState()
}

export async function restartWatchCycle() {
  const runtime = await waitForRuntime()
  await runtime.engine.restartWatchCycle()
  runtime.collector.clear()
  runtime.pumpPoller.reset()
  runtime.axiomPoller?.reset()
  runtime.fomoPoller?.reset()
  if (runtime.store.config.pumpIngestEnabled) {
    runtime.pumpPoller.start()
    try {
      await runtime.pumpPoller.pollOnce()
    } catch (error) {
      runtime.store.log(
        "warn",
        `[wallet] Pump poll failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (runtime.store.config.axiomIngestEnabled && runtime.axiomPoller) {
    runtime.axiomPoller.start()
    void runtime.axiomPoller.pollOnce()
  }
  runtime.fomoPoller?.stop()
  runtime.engine.rearmScheduler()
  await runtime.engine.syncQualifiedBoard()
  runtime.store.emitState()
}

/**
 * Persist the current operational config to Redis so all future cold-start
 * isolates pick it up without a redeploy. Call this after any admin change to
 * fomoTreasuryWallet, snapshotMinMs/Max, allocationAmount, or treasury key.
 */
export async function persistDurableConfig(
  runtime: Runtime,
  opts: { encryptedKey?: string | null } = {},
): Promise<void> {
  const cfg = runtime.store.config
  await saveDurableConfig({
    fomoTreasuryWallet: cfg.fomoTreasuryWallet,
    treasuryPublicAddress: runtime.store.treasuryPublicAddress || cfg.treasuryPublicAddress || null,
    snapshotMinMs: cfg.snapshotMinMs,
    snapshotMaxMs: cfg.snapshotMaxMs,
    allocationAmount: cfg.allocationAmount,
    creatorRewardShareBps: cfg.creatorRewardShareBps,
    // Only update the key field if explicitly provided; undefined = keep existing.
    ...(opts.encryptedKey !== undefined ? { encryptedTreasuryKey: opts.encryptedKey } : {}),
  })
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
