import { minutesLabel } from "@/lib/format"
import { DEFAULT_MIGRATION_BONUS, PUMP_BOND_TARGET_SOL } from "@/lib/coin"
import type {
  Callout,
  ChannelMessage,
  ClientState,
  EngineConfig,
  EngineEvent,
  EngineStatus,
  MigrationAudit,
  SnapshotAudit,
  SnapshotPhase,
} from "@/engine/types"

export const DEFAULT_CONFIG: EngineConfig = {
  allocationAmount: 100,
  distributionToken: "BONK",
  coinMint: null,
  coinName: null,
  snapshotMinMs: 5 * 60_000,
  snapshotMaxMs: 15 * 60_000,
  startupSnapshotDelayMs: 12_000,
  rouletteFrameMs: 420,
  rouletteFrameCount: 10,
  mockTxDelayMs: 900,
  feederEnabled: true,
  feederMinMs: 1_400,
  feederMaxMs: 3_600,
  pumpIngestEnabled: false,
  axiomIngestEnabled: false,
  explorerTxTemplate: "https://solscan.io/tx/{signature}",
  explorerAddressTemplate: "https://solscan.io/account/{address}",
  treasuryPublicAddress: "SnapTreas1BroadcastOnly1111111111111111111",
  calloutSources: ["demo-feed", "private-ingest", "pump-fun", "axiom"],
  migrationBonusAmount: DEFAULT_MIGRATION_BONUS,
  migrationMinCallouts: 3,
  migrationPollMs: 15_000,
}

export class EngineStore {
  readonly startedAt: string
  config: EngineConfig
  schedulerPaused = false
  snapshotInProgress = false
  phase: SnapshotPhase = "idle"
  lastSnapshotAt: string | null = null
  nextSnapshotAt: string | null = null
  telegramConnected = false
  telegramChannelId: string | null = null
  treasuryPublicAddress: string
  treasuryBalance = 1_000_000_000
  treasuryKeyConfigured = false
  watchStartedAt: string | null = null
  migrationBonded = false
  migrationPaid = false
  migrationLastCheckAt: string | null = null
  migrationLastError: string | null = null
  migrationEligibleCount = 0
  migrationProgressPercent: number | null = null
  migrationSolRaised: number | null = null
  migrationSolTarget = PUMP_BOND_TARGET_SOL
  pumpIngest = {
    enabled: false,
    connected: false,
    lastPollAt: null as string | null,
    lastError: null as string | null,
    lastFeedCount: 0,
    accepted: 0,
    skipped: 0,
  }
  axiomIngest = {
    enabled: false,
    connected: false,
    lastPollAt: null as string | null,
    lastError: null as string | null,
    lastFeedCount: 0,
    accepted: 0,
    skipped: 0,
    cookieConfigured: false,
  }

  private ensureAxiomIngest() {
    if (!this.axiomIngest) {
      this.axiomIngest = {
        enabled: false,
        connected: false,
        lastPollAt: null,
        lastError: null,
        lastFeedCount: 0,
        accepted: 0,
        skipped: 0,
        cookieConfigured: false,
      }
    }
    if (this.config.axiomIngestEnabled === undefined) {
      this.config = { ...this.config, axiomIngestEnabled: false }
    }
  }
  private audits: SnapshotAudit[] = []
  private migrations: MigrationAudit[] = []
  private listeners = new Set<(event: EngineEvent) => void>()

  constructor(
    private readonly getCallouts: () => Callout[],
    private readonly getMessages: () => ChannelMessage[],
    config: EngineConfig = DEFAULT_CONFIG,
    startedAt = new Date().toISOString(),
  ) {
    this.config = { ...config }
    this.treasuryPublicAddress = config.treasuryPublicAddress
    this.startedAt = startedAt
    this.watchStartedAt = config.coinMint ? startedAt : null
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emitState() {
    const event: EngineEvent = { type: "state", state: this.clientState() }
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error("[store] state listener failed", error)
      }
    }
  }

  log(level: "info" | "warn" | "error", message: string) {
    const event: EngineEvent = { type: "log", level, message, at: new Date().toISOString() }
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error("[store] log listener failed", error)
      }
    }
    this.emitState()
  }

  clientState(): ClientState {
    return {
      status: this.status(),
      messages: this.getMessages(),
      callouts: this.getCallouts(),
      audits: this.audits.map((audit) => ({
        ...audit,
        callouts: [...audit.callouts],
        rouletteCandidatePool: [...audit.rouletteCandidatePool],
        transactions: audit.transactions.map((tx) => ({ ...tx })),
      })),
      migrations: this.migrations.map((row) => ({
        ...row,
        winner: row.winner ? { ...row.winner } : null,
        transaction: row.transaction ? { ...row.transaction } : null,
      })),
    }
  }

  status(): EngineStatus {
    this.ensureAxiomIngest()
    const windowStart = this.lastSnapshotAt ?? this.startedAt
    return {
      running: !this.schedulerPaused,
      schedulerPaused: this.schedulerPaused,
      feederEnabled: this.config.feederEnabled,
      snapshotInProgress: this.snapshotInProgress,
      phase: this.phase,
      startedAt: this.startedAt,
      lastSnapshotAt: this.lastSnapshotAt,
      nextSnapshotAt: this.nextSnapshotAt,
      nextSnapshotRangeLabel: minutesLabel(this.config.snapshotMinMs, this.config.snapshotMaxMs),
      telegramConnected: this.telegramConnected,
      telegramChannelId: this.telegramChannelId,
      calloutsInWindow: this.getCallouts().filter((c) => c.capturedAt >= windowStart).length,
      treasuryPublicAddress: this.treasuryPublicAddress,
      treasuryBalance: this.treasuryBalance,
      treasuryKeyConfigured: this.treasuryKeyConfigured,
      migration: {
        watchStartedAt: this.watchStartedAt,
        bonded: this.migrationBonded,
        paid: this.migrationPaid,
        lastCheckAt: this.migrationLastCheckAt,
        lastError: this.migrationLastError,
        eligibleCount: this.migrationEligibleCount,
        progressPercent: this.migrationProgressPercent,
        solRaised: this.migrationSolRaised,
        solTarget: this.migrationSolTarget,
      },
      pumpIngest: { ...this.pumpIngest },
      axiomIngest: { ...this.axiomIngest },
      config: { ...this.config },
    }
  }

  upsertAudit(audit: SnapshotAudit) {
    const index = this.audits.findIndex((item) => item.id === audit.id)
    if (index === -1) {
      this.audits = [audit, ...this.audits].slice(0, 100)
    } else {
      this.audits = this.audits.map((item, i) => (i === index ? audit : item))
    }
    this.emitState()
  }

  upsertMigration(audit: MigrationAudit) {
    const index = this.migrations.findIndex((item) => item.id === audit.id)
    if (index === -1) {
      this.migrations = [audit, ...this.migrations].slice(0, 20)
    } else {
      this.migrations = this.migrations.map((item, i) => (i === index ? audit : item))
    }
    this.emitState()
  }

  listAudits(): SnapshotAudit[] {
    return [...this.audits]
  }

  listMigrations(): MigrationAudit[] {
    return [...this.migrations]
  }

  resetMigrationForMint(at = new Date().toISOString()) {
    this.watchStartedAt = at
    this.migrationBonded = false
    this.migrationPaid = false
    this.migrationLastCheckAt = null
    this.migrationLastError = null
    this.migrationEligibleCount = 0
    this.migrationProgressPercent = null
    this.migrationSolRaised = null
    this.migrationSolTarget = PUMP_BOND_TARGET_SOL
  }
}
