export type Callout = {
  id: string
  token: string
  callerUsername: string
  wallet: string
  capturedAt: string
  source: string
  thesis?: string
}

export type SelectionMethod = "node:crypto.randomInt"

export type RecipientKind = "last_callout" | "roulette" | "migration_bonus"

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
  | "intro"
  | "snapshot"
  | "roulette"
  | "recipients"
  | "distribution"
  | "final"
  | "qualified"
  | "bond"
  | "migration"

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
  coinMint: string | null
  coinName: string | null
  snapshotMinMs: number
  snapshotMaxMs: number
  startupSnapshotDelayMs: number | null
  rouletteFrameMs: number
  rouletteFrameCount: number
  mockTxDelayMs: number
  feederEnabled: boolean
  feederMinMs: number
  feederMaxMs: number
  pumpIngestEnabled: boolean
  axiomIngestEnabled: boolean
  explorerTxTemplate: string
  explorerAddressTemplate: string
  treasuryPublicAddress: string
  calloutSources: string[]
  /**
   * Legacy fixed bonus size. Bond lottery now splits the remaining treasury
   * token balance; this is only used as a mock/fallback floor when balance is unset.
   */
  migrationBonusAmount: number
  /** Winners in the one-time bond lottery (remaining supply split evenly). */
  migrationWinnerCount: number
  /** Minimum accepted callouts since mint watch started. */
  migrationMinCallouts: number
  migrationPollMs: number
  /** Share of claimed creator fees paid out each post-bond snapshot (basis points). */
  creatorRewardShareBps: number
}

export type MigrationAudit = {
  id: string
  mint: string
  distributionToken: string
  detectedAt: string
  watchStartedAt: string
  minCallouts: number
  eligibleCount: number
  holderCount: number
  /** First winner — kept for older ops UI. */
  winner: {
    wallet: string
    callerUsername: string
    calloutCount: number
  } | null
  winners: Array<{
    wallet: string
    callerUsername: string
    calloutCount: number
    amount: number
  }>
  selectionEntropyHex: string
  /** Total tokens sent across all bond lottery winners. */
  amount: number
  transaction: DistributionTx | null
  transactions: DistributionTx[]
  confirmationStatus: "in_progress" | "confirmed" | "partial_failure" | "skipped"
  skipReason: string | null
  telegramMessageIds: {
    bond?: string
    detected?: string
    distribution?: string
    final?: string
  }
  completedAt: string | null
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
  treasuryKeyConfigured: boolean
  migration: {
    watchStartedAt: string | null
    bonded: boolean
    paid: boolean
    lastCheckAt: string | null
    lastError: string | null
    eligibleCount: number
    progressPercent: number | null
    solRaised: number | null
    solTarget: number
  }
  pumpIngest: {
    enabled: boolean
    connected: boolean
    lastPollAt: string | null
    lastError: string | null
    lastFeedCount: number
    accepted: number
    skipped: number
  }
  axiomIngest: {
    enabled: boolean
    connected: boolean
    lastPollAt: string | null
    lastError: string | null
    lastFeedCount: number
    accepted: number
    skipped: number
    cookieConfigured: boolean
  }
  fomoIngest: {
    enabled: boolean
    connected: boolean
    lastPollAt: string | null
    lastError: string | null
    lastFeedCount: number
    accepted: number
    skipped: number
    unresolved: number
    apiKeyConfigured: boolean
  }
  config: EngineConfig
}

export type ClientState = {
  status: EngineStatus
  messages: ChannelMessage[]
  callouts: Callout[]
  audits: SnapshotAudit[]
  migrations: MigrationAudit[]
  /** Recent engine/wallet console lines for /ops. */
  logs: EngineLog[]
}

export type EngineLog = {
  id: string
  at: string
  level: "info" | "warn" | "error"
  message: string
}

export type EngineEvent =
  | { type: "state"; state: ClientState }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; at: string }
