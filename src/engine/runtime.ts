import { CalloutCollector } from "@/engine/collector"
import { CalloutFeeder } from "@/engine/feeder"
import { SnapshotEngine, realClock } from "@/engine/snapshot-engine"
import { DEFAULT_CONFIG, EngineStore } from "@/engine/store"
import { MockTreasury } from "@/engine/treasury"
import type { EngineConfig } from "@/engine/types"
import { createBroadcast } from "@/telegram/broadcast"

export type Runtime = {
  engine: SnapshotEngine
  store: EngineStore
  collector: CalloutCollector
  feeder: CalloutFeeder
}

const globalRef = globalThis as typeof globalThis & { __calloutSnap?: Runtime }

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function loadConfig(): EngineConfig {
  const fastStart = process.env.DEMO_FAST_START !== "false"
  return {
    ...DEFAULT_CONFIG,
    allocationAmount: envNumber("ALLOCATION_AMOUNT", DEFAULT_CONFIG.allocationAmount),
    distributionToken: process.env.DISTRIBUTION_TOKEN?.trim() || DEFAULT_CONFIG.distributionToken,
    snapshotMinMs: envNumber("SNAPSHOT_MIN_MS", DEFAULT_CONFIG.snapshotMinMs),
    snapshotMaxMs: envNumber("SNAPSHOT_MAX_MS", DEFAULT_CONFIG.snapshotMaxMs),
    startupSnapshotDelayMs: fastStart
      ? envNumber("STARTUP_SNAPSHOT_DELAY_MS", DEFAULT_CONFIG.startupSnapshotDelayMs ?? 12_000)
      : null,
    feederEnabled: process.env.DEMO_FEED !== "false",
    explorerTxTemplate: process.env.EXPLORER_TX_URL || DEFAULT_CONFIG.explorerTxTemplate,
    explorerAddressTemplate: process.env.EXPLORER_ADDRESS_URL || DEFAULT_CONFIG.explorerAddressTemplate,
    treasuryPublicAddress: process.env.TREASURY_PUBLIC_ADDRESS || DEFAULT_CONFIG.treasuryPublicAddress,
  }
}

export function startRuntime(): Runtime {
  if (globalRef.__calloutSnap) return globalRef.__calloutSnap

  const { preview, broadcast, telegramConnected, channelId } = createBroadcast()
  const collector = new CalloutCollector()
  const config = loadConfig()
  const bag: { store: EngineStore | null } = { store: null }
  const store = new EngineStore(
    () => collector.listSince(new Date(bag.store?.lastSnapshotAt ?? bag.store?.startedAt ?? new Date().toISOString())),
    () => preview.getMessages(),
    config,
  )
  bag.store = store
  store.telegramConnected = telegramConnected
  store.telegramChannelId = channelId

  const treasury = new MockTreasury(
    () => store.config,
    (ms) => realClock.sleep(ms),
    1_000_000,
    store.config.treasuryPublicAddress,
  )
  store.treasuryPublicAddress = treasury.publicAddress
  store.treasuryBalance = treasury.balance

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

  for (let i = 0; i < 8; i += 1) {
    feeder.emitOne(new Date(Date.now() - (8 - i) * 1_500))
  }

  feeder.start()
  engine.start()

  const runtime = { engine, store, collector, feeder }
  globalRef.__calloutSnap = runtime
  return runtime
}

export function getRuntime(): Runtime {
  return globalRef.__calloutSnap ?? startRuntime()
}
