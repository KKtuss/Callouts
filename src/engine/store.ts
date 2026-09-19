import { minutesLabel } from "@/lib/format"
import type {
  Callout,
  ChannelMessage,
  ClientState,
  EngineConfig,
  EngineEvent,
  EngineStatus,
  SnapshotAudit,
  SnapshotPhase,
} from "@/engine/types"

export const DEFAULT_CONFIG: EngineConfig = {
  allocationAmount: 100,
  distributionToken: "TOKEN",
  snapshotMinMs: 5 * 60_000,
  snapshotMaxMs: 15 * 60_000,
  startupSnapshotDelayMs: 12_000,
  rouletteFrameMs: 420,
  rouletteFrameCount: 10,
  mockTxDelayMs: 900,
  feederEnabled: true,
  feederMinMs: 1_400,
  feederMaxMs: 3_600,
  explorerTxTemplate: "https://solscan.io/tx/{signature}",
  explorerAddressTemplate: "https://solscan.io/account/{address}",
  treasuryPublicAddress: "SnapTreas1BroadcastOnly1111111111111111111",
  calloutSources: ["demo-feed", "private-ingest"],
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
  treasuryBalance = 1_000_000
  private audits: SnapshotAudit[] = []
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
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emitState() {
    const event: EngineEvent = { type: "state", state: this.clientState() }
    for (const listener of this.listeners) listener(event)
  }

  log(level: "info" | "warn" | "error", message: string) {
    const event: EngineEvent = { type: "log", level, message, at: new Date().toISOString() }
    for (const listener of this.listeners) listener(event)
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
    }
  }

  status(): EngineStatus {
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

  listAudits(): SnapshotAudit[] {
    return [...this.audits]
  }
}
