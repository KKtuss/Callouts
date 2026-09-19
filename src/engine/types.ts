export type Callout = {
  id: string
  token: string
  callerUsername: string
  wallet: string
  capturedAt: string
  source: string
}

export type SelectionMethod = "node:crypto.randomInt"

export type RecipientKind = "last_callout" | "roulette"

export type TxStatus = "pending" | "confirmed" | "failed"

export type DistributionTx = {
  kind: RecipientKind
  calloutId: string
  token: string
  callerUsername: string
  wallet: string
  amount: number
  distributionToken: string
  signature: string | null
  explorerUrl: string | null
  status: TxStatus
  submittedAt: string | null
  confirmedAt: string | null
  error: string | null
}

export type RecipientSelection = {
  lastCallout: Callout
  roulettePool: Callout[]
  rouletteIndex: number
  rouletteWinner: Callout
  entropyHex: string
  method: SelectionMethod
  selectedAt: string
}

export type SnapshotPhase =
  | "idle"
  | "capturing"
  | "roulette"
  | "announcing"
  | "distributing"
  | "finalizing"

export type SnapshotTrigger = "scheduler" | "admin"

export type SnapshotAudit = {
  id: string
  trigger: SnapshotTrigger
  snapshotTimestamp: string
  previousSnapshotTimestamp: string | null
  windowStart: string
  windowEnd: string
  calloutCount: number
  callouts: Callout[]
  lastCallout: Callout
  rouletteCandidatePool: Callout[]
  rouletteIndex: number
  rouletteWinner: Callout
  selectionEntropyHex: string
  selectionMethod: SelectionMethod
  selectionCommittedAt: string
  animationStartedAt: string | null
  allocationAmount: number
  distributionToken: string
  totalDistributed: number
  transactions: DistributionTx[]
  confirmationStatus: "in_progress" | "confirmed" | "partial_failure" | "skipped"
  skipReason: string | null
  telegramMessageIds: {
    snapshot?: string
    roulette?: string
    recipients?: string
    distribution?: string
    final?: string
  }
  createdAt: string
  completedAt: string | null
}

export type ChannelMessageKind =
  | "snapshot"
  | "roulette"
  | "recipients"
  | "distribution"
  | "final"

export type ChannelMessage = {
  id: string
  telegramMessageId: number | null
  kind: ChannelMessageKind
  html: string
  text: string
  createdAt: string
  editedAt: string | null
  editCount: number
}

export type EngineConfig = {
  allocationAmount: number
  distributionToken: string
  snapshotMinMs: number
  snapshotMaxMs: number
  startupSnapshotDelayMs: number | null
  rouletteFrameMs: number
  rouletteFrameCount: number
  mockTxDelayMs: number
  feederEnabled: boolean
  feederMinMs: number
  feederMaxMs: number
  explorerTxTemplate: string
  explorerAddressTemplate: string
  treasuryPublicAddress: string
  calloutSources: string[]
}

export type EngineStatus = {
  running: boolean
  schedulerPaused: boolean
  feederEnabled: boolean
  snapshotInProgress: boolean
  phase: SnapshotPhase
  startedAt: string
  lastSnapshotAt: string | null
  nextSnapshotAt: string | null
  nextSnapshotRangeLabel: string
  telegramConnected: boolean
  telegramChannelId: string | null
  calloutsInWindow: number
  treasuryPublicAddress: string
  treasuryBalance: number
  config: EngineConfig
}

export type ClientState = {
  status: EngineStatus
  messages: ChannelMessage[]
  callouts: Callout[]
  audits: SnapshotAudit[]
}

export type EngineEvent =
  | { type: "state"; state: ClientState }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; at: string }
