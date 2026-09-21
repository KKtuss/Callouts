import { minutesLabel } from "@/lib/format"
import { DEFAULT_MIGRATION_BONUS, PUMP_BOND_TARGET_SOL, PUMP_TOTAL_SUPPLY } from "@/lib/coin"
import { auditsFromRounds, type PersistedRound } from "@/engine/persist-watch"
import { isCalloutInCurrentWindow } from "@/lib/snapshot-window"
import type {
  Callout,
  ChannelMessage,
  ClientState,
  EngineConfig,
  EngineEvent,
  EngineLog,
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
  calloutSources: ["demo-feed", "private-ingest", "pump-fun", "axiom", "fomo"],
  migrationBonusAmount: DEFAULT_MIGRATION_BONUS,
  migrationWinnerCount: 5,
  migrationMinCallouts: 3,
  migrationPollMs: 15_000,
  creatorRewardShareBps: 1_000,
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
  fomoIngest = {
    enabled: false,
    connected: false,
    lastPollAt: null as string | null,
    lastError: null as string | null,
    lastFeedCount: 0,
    accepted: 0,
    skipped: 0,
    unresolved: 0,
    apiKeyConfigured: false,
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
  private logs: EngineLog[] = []
  private listeners = new Set<(event: EngineEvent) => void>()
  private logSeq = 0
  /** Accepted callouts since this mint watch started (bonding eligibility). */
  private lifetimeCallouts: Callout[] = []

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
    const at = new Date().toISOString()
    this.logSeq += 1
    const entry = { id: `log-${this.logSeq}`, at, level, message }
    this.logs = [entry, ...this.logs].slice(0, 200)
    if (level === "error") console.error(`[engine] ${message}`)
    else if (level === "warn") console.warn(`[engine] ${message}`)
    else console.log(`[engine] ${message}`)
    const event: EngineEvent = { type: "log", level, message, at }
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
        winners: (row.winners ?? []).map((w) => ({ ...w })),
        transaction: row.transaction ? { ...row.transaction } : null,
        transactions: (row.transactions ?? []).map((tx) => ({ ...tx })),
      })),
      logs: [...this.logs],
    }
  }

  status(): EngineStatus {
    this.ensureAxiomIngest()
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
      calloutsInWindow: this.getCallouts().filter((c) =>
        isCalloutInCurrentWindow(c.capturedAt, this.lastSnapshotAt, this.startedAt),
      ).length,
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
      fomoIngest: { ...this.fomoIngest },
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

  listLifetimeCallouts(): Callout[] {
    return [...this.lifetimeCallouts]
  }

  rememberLifetimeCallout(callout: Callout) {
    const id = callout.id
    if (!id) return
    if (this.lifetimeCallouts.some((row) => row.id === id)) return
    this.lifetimeCallouts.push(callout)
    if (this.lifetimeCallouts.length > 2_000) {
      this.lifetimeCallouts = this.lifetimeCallouts.slice(-2_000)
    }
  }

  rememberLifetimeCallouts(rows: Callout[]) {
    for (const row of rows) this.rememberLifetimeCallout(row)
  }

  hydrateLifetimeCallouts(rows: Callout[]) {
    const byId = new Map(this.lifetimeCallouts.map((row) => [row.id, row]))
    for (const row of rows) {
      if (!row.id) continue
      byId.set(row.id, row)
    }
    this.lifetimeCallouts = [...byId.values()].sort(
      (a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt),
    )
  }

  clearLifetimeCallouts() {
    this.lifetimeCallouts = []
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

  /** Wipe rounds, bonuses, and window clock when the watched mint changes. */
  resetHistoryForMint(at = new Date().toISOString()) {
    this.audits = []
    this.migrations = []
    this.lifetimeCallouts = []
    this.lastSnapshotAt = null
    this.nextSnapshotAt = null
    this.snapshotInProgress = false
    this.phase = "idle"
    this.treasuryBalance = PUMP_TOTAL_SUPPLY
    this.schedulerPaused = false
    this.resetMigrationForMint(at)
  }

  /** Fresh snapshot window without wiping settled round history. */
  resetWindowForNewCycle(at = new Date().toISOString()) {
    this.lastSnapshotAt = at
    this.nextSnapshotAt = null
    this.snapshotInProgress = false
    this.phase = "idle"
    this.schedulerPaused = false
    this.watchStartedAt = at
  }

  hydrateMigration(paid: boolean | null) {
    if (paid === true) {
      this.migrationPaid = true
      this.migrationBonded = true
    }
  }

  hydrateScheduler(nextSnapshotAt: string | null, paused: boolean | null) {
    if (paused === true) {
      this.schedulerPaused = true
      this.nextSnapshotAt = null
      return
    }
    if (paused === false) this.schedulerPaused = false
    if (this.schedulerPaused) {
      this.nextSnapshotAt = null
      return
    }
    if (!nextSnapshotAt || !Number.isFinite(Date.parse(nextSnapshotAt))) return
    const incoming = Date.parse(nextSnapshotAt)
    const now = Date.now()
    const current = this.nextSnapshotAt ? Date.parse(this.nextSnapshotAt) : NaN
    const last = this.lastSnapshotAt ? Date.parse(this.lastSnapshotAt) : 0
    if (last && incoming <= last + 2_000) return
    if (Number.isFinite(current) && current > now && incoming <= now) return
    if (Number.isFinite(current) && current > now && incoming > now && incoming < current) return
    this.nextSnapshotAt = nextSnapshotAt
  }

  hydrateLedger(lastSnapshotAt: string | null, rounds: PersistedRound[]) {
    const fromRounds = rounds
      .map((round) => round.at)
      .filter((at) => Number.isFinite(Date.parse(at)))
      .sort()
      .at(-1) ?? null
    const incoming = lastSnapshotAt && Number.isFinite(Date.parse(lastSnapshotAt))
      ? lastSnapshotAt
      : fromRounds
    if (incoming) {
      if (!this.lastSnapshotAt || Date.parse(incoming) > Date.parse(this.lastSnapshotAt)) {
        this.lastSnapshotAt = incoming
      }
    }
    const byId = new Map(this.audits.map((audit) => [audit.id, audit]))
    for (const audit of auditsFromRounds(rounds, this.config.explorerTxTemplate)) {
      const existing = byId.get(audit.id)
      if (!existing) {
        byId.set(audit.id, audit)
        continue
      }
      if (existing.selectionEntropyHex !== "hydrated") continue
      // Refresh hydrated rows so Redis source/thesis fixes stick.
      byId.set(audit.id, audit)
    }
    this.audits = [...byId.values()]
      .sort((a, b) => Date.parse(b.snapshotTimestamp) - Date.parse(a.snapshotTimestamp))
      .slice(0, 100)
  }
}
