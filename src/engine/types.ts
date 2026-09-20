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
  /** Tokens sent on bonding/migration (default 10M = 1% of 1B Pump supply). */
  migrationBonusAmount: number
  /** Minimum accepted callouts since mint watch started. */
  migrationMinCallouts: number
  migrationPollMs: number
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
  winner: {
    wallet: string
    callerUsername: string
    calloutCount: number
  } | null
  selectionEntropyHex: string
  amount: number
  transaction: DistributionTx | null
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
  config: EngineConfig
}

export type ClientState = {
  status: EngineStatus
  messages: ChannelMessage[]
  callouts: Callout[]
  audits: SnapshotAudit[]
  migrations: MigrationAudit[]
}

export type EngineEvent =
  | { type: "state"; state: ClientState }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; at: string }
