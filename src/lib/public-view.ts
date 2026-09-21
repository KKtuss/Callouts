import { PUMP_TOTAL_SUPPLY } from "@/lib/coin"
import { explorerAddressUrl } from "@/lib/explorer"
import {
  displayToken,
  displayUsername,
  formatInteger,
  formatSupplyPercent,
  truncateWallet,
} from "@/lib/format"
import { isCalloutInCurrentWindow } from "@/lib/snapshot-window"
import { sumRewards, type RewardTotals } from "@/lib/rewards"
import type {
  Callout,
  ChannelMessage,
  ClientState,
  DistributionTx,
  MigrationAudit,
  SnapshotAudit,
  SnapshotPhase,
} from "@/engine/types"

export type PublicCallout = {
  id: string
  username: string
  wallet: string
  walletShort: string
  walletUrl: string
  token: string
  capturedAt: string
  source: "pump.fun" | "fomo" | "axiom" | "other"
  thesis?: string
}

export type PublicTx = {
  kind: "last_caller" | "random_caller" | "migration_bonus"
  username: string
  wallet: string
  walletShort: string
  walletUrl: string
  amount: number
  amountLabel: string
  distributionToken: string
  signature: string | null
  explorerUrl: string | null
  status: DistributionTx["status"]
}

export type PublicRound = {
  id: string
  number: number
  timestamp: string
  calloutCount: number
  status: SnapshotAudit["confirmationStatus"]
  skipReason: string | null
  allocationAmount: number
  distributionToken: string
  payoutLabel: string
  lastCaller: PublicCallout | null
  randomCaller: PublicCallout | null
  transactions: PublicTx[]
  explorerLinks: string[]
}

export type PublicMigration = {
  id: string
  detectedAt: string
  eligibleCount: number
  holderCount: number
  minCallouts: number
  amount: number
  amountLabel: string
  confirmationStatus: MigrationAudit["confirmationStatus"]
  skipReason: string | null
  winner: {
    username: string
    wallet: string
    walletShort: string
    walletUrl: string
    calloutCount: number
  } | null
  explorerUrl: string | null
}

export type PublicMessage = {
  id: string
  kind: ChannelMessage["kind"]
  text: string
  createdAt: string
}

export type PublicView = {
  engine: {
    live: boolean
    paused: boolean
    phase: SnapshotPhase
    snapshotInProgress: boolean
    startedAt: string
    lastSnapshotAt: string | null
    nextSnapshotRangeLabel: string
    calloutsInWindow: number
    lastPayoutAt: string | null
  }
  mint: {
    address: string | null
    addressShort: string | null
    explorerUrl: string | null
    ticker: string
    name: string | null
  }
  treasury: {
    address: string
    addressShort: string
    explorerUrl: string | null
    balance: number
    balanceLabel: string
  }
  allocation: {
    amount: number
    amountLabel: string
    distributionToken: string
    supplyPercent: number
    supplyPercentLabel: string
  }
  totals: RewardTotals & {
    snapshots: number
    roundsSettled: number
    callouts: number
  }
  bonding: {
    watchStartedAt: string | null
    bonded: boolean
    paid: boolean
    eligibleCount: number
    progressPercent: number | null
    solRaised: number | null
    solTarget: number
    bonusAmount: number
    bonusAmountLabel: string
    bonusSupplyPercentLabel: string
    minCallouts: number
  }
  sources: {
    pumpFun: { enabled: boolean; connected: boolean }
    axiom: { enabled: boolean; connected: boolean }
  }
  telegram: {
    connected: boolean
    publicUrl: string | null
  }
  social: {
    xUrl: string | null
  }
  windowCallouts: PublicCallout[]
  rounds: PublicRound[]
  migrations: PublicMigration[]
  messages: PublicMessage[]
  activeRound: PublicRound | null
}

function mapSource(source: string): PublicCallout["source"] {
  const s = source.toLowerCase()
  if (s.includes("fomo")) return "fomo"
  if (s.includes("pump")) return "pump.fun"
  if (s.includes("axiom")) return "axiom"
  return "other"
}

function mapCallout(callout: Callout, addressTemplate: string): PublicCallout {
  return {
    id: callout.id,
    username: displayUsername(callout.callerUsername),
    wallet: callout.wallet,
    walletShort: truncateWallet(callout.wallet, 4, 3),
    walletUrl: callout.wallet
      ? explorerAddressUrl(callout.wallet, addressTemplate)
      : "",
    token: displayToken(callout.token),
    capturedAt: callout.capturedAt,
    source: mapSource(callout.source),
    thesis: callout.thesis,
  }
}

function mapTxKind(kind: DistributionTx["kind"]): PublicTx["kind"] {
  if (kind === "last_callout") return "last_caller"
  if (kind === "roulette") return "random_caller"
  return "migration_bonus"
}

function mapTx(tx: DistributionTx, addressTemplate: string): PublicTx {
  return {
    kind: mapTxKind(tx.kind),
    username: displayUsername(tx.callerUsername),
    wallet: tx.wallet,
    walletShort: truncateWallet(tx.wallet, 4, 3),
    walletUrl: tx.wallet ? explorerAddressUrl(tx.wallet, addressTemplate) : "",
    amount: tx.amount,
    amountLabel: `${formatInteger(tx.amount)} ${tx.distributionToken}`,
    distributionToken: tx.distributionToken,
    signature: tx.signature,
    explorerUrl: tx.explorerUrl,
    status: tx.status,
  }
}

function mapRound(
  audit: SnapshotAudit,
  number: number,
  addressTemplate: string,
): PublicRound {
  const last = audit.lastCallout
    ? mapCallout(audit.lastCallout, addressTemplate)
    : null
  const random = audit.rouletteWinner
    ? mapCallout(audit.rouletteWinner, addressTemplate)
    : null
  const transactions = audit.transactions.map((tx) => mapTx(tx, addressTemplate))
  const explorerLinks = transactions
    .map((tx) => tx.explorerUrl)
    .filter((url): url is string => Boolean(url))

  return {
    id: audit.id,
    number,
    timestamp: audit.snapshotTimestamp,
    calloutCount: audit.calloutCount,
    status: audit.confirmationStatus,
    skipReason: audit.skipReason,
    allocationAmount: audit.allocationAmount,
    distributionToken: audit.distributionToken,
    payoutLabel:
      audit.calloutCount > 0
        ? `2 × ${formatInteger(audit.allocationAmount)} ${audit.distributionToken}`
        : "—",
    lastCaller: last,
    randomCaller: random,
    transactions,
    explorerLinks,
  }
}

function mapMigration(audit: MigrationAudit, addressTemplate: string): PublicMigration {
  return {
    id: audit.id,
    detectedAt: audit.detectedAt,
    eligibleCount: audit.eligibleCount,
    holderCount: audit.holderCount,
    minCallouts: audit.minCallouts,
    amount: audit.amount,
    amountLabel: `${formatInteger(audit.amount)} ${audit.distributionToken}`,
    confirmationStatus: audit.confirmationStatus,
    skipReason: audit.skipReason,
    winner: audit.winner
      ? {
          username: displayUsername(audit.winner.callerUsername),
          wallet: audit.winner.wallet,
          walletShort: truncateWallet(audit.winner.wallet, 4, 3),
          walletUrl: explorerAddressUrl(audit.winner.wallet, addressTemplate),
          calloutCount: audit.winner.calloutCount,
        }
      : null,
    explorerUrl: audit.transaction?.explorerUrl ?? null,
  }
}

function publicEnv(name: string): string | null {
  const value = process.env[name]?.trim()
  return value || null
}

export function toPublicView(state: ClientState): PublicView {
  const cfg = state.status.config
  const addressTemplate = cfg.explorerAddressTemplate
  const ticker = displayToken(cfg.distributionToken).replace(/^\$/, "")

  const chronological = [...state.audits].sort(
    (a, b) => Date.parse(a.snapshotTimestamp) - Date.parse(b.snapshotTimestamp),
  )
  const numberById = new Map(
    chronological.map((audit, index) => [audit.id, index + 1] as const),
  )

  const rounds = state.audits.map((audit) =>
    mapRound(audit, numberById.get(audit.id) ?? 0, addressTemplate),
  )

  const windowCallouts = state.callouts
    .filter((c) =>
      isCalloutInCurrentWindow(c.capturedAt, state.status.lastSnapshotAt, state.status.startedAt),
    )
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))
    .map((c) => mapCallout(c, addressTemplate))

  const lastCompleted = state.audits.find(
    (a) => a.confirmationStatus === "confirmed" || a.confirmationStatus === "partial_failure",
  )
  const lastPayoutAt =
    lastCompleted?.completedAt ??
    lastCompleted?.transactions.find((t) => t.confirmedAt)?.confirmedAt ??
    lastCompleted?.snapshotTimestamp ??
    null

  const activeAudit =
    state.status.snapshotInProgress
      ? state.audits.find((a) => !a.completedAt) ?? state.audits[0] ?? null
      : null

  const treasuryAddress = state.status.treasuryPublicAddress || ""

  const totals = sumRewards(
    [
      ...state.audits.flatMap((audit) => audit.transactions),
      ...state.migrations.flatMap((m) => (m.transaction ? [m.transaction] : [])),
    ],
    ticker,
  )
  const allocationSupplyPercent = (cfg.allocationAmount / PUMP_TOTAL_SUPPLY) * 100

  return {
    engine: {
      live: state.status.running && !state.status.schedulerPaused,
      paused: state.status.schedulerPaused,
      phase: state.status.phase,
      snapshotInProgress: state.status.snapshotInProgress,
      startedAt: state.status.startedAt,
      lastSnapshotAt: state.status.lastSnapshotAt,
      nextSnapshotRangeLabel: state.status.nextSnapshotRangeLabel,
      calloutsInWindow: state.status.calloutsInWindow,
      lastPayoutAt,
    },
    mint: {
      address: cfg.coinMint,
      addressShort: cfg.coinMint ? truncateWallet(cfg.coinMint, 4, 3) : null,
      explorerUrl: cfg.coinMint
        ? explorerAddressUrl(cfg.coinMint, addressTemplate)
        : null,
      ticker,
      name: cfg.coinName,
    },
    treasury: {
      address: treasuryAddress,
      addressShort: treasuryAddress
        ? truncateWallet(treasuryAddress, 4, 3)
        : "—",
      explorerUrl: treasuryAddress
        ? explorerAddressUrl(treasuryAddress, addressTemplate)
        : null,
      balance: state.status.treasuryBalance,
      balanceLabel: `${formatInteger(state.status.treasuryBalance)} ${ticker}`,
    },
    allocation: {
      amount: cfg.allocationAmount,
      amountLabel: `${formatInteger(cfg.allocationAmount)} ${ticker}`,
      distributionToken: ticker,
      supplyPercent: allocationSupplyPercent,
      supplyPercentLabel: formatSupplyPercent(allocationSupplyPercent),
    },
    totals: {
      ...totals,
      snapshots: state.audits.length,
      roundsSettled: state.audits.filter(
        (a) => a.confirmationStatus === "confirmed" || a.confirmationStatus === "partial_failure",
      ).length,
      callouts: state.callouts.length,
    },
    bonding: {
      watchStartedAt: state.status.migration?.watchStartedAt ?? null,
      bonded: Boolean(state.status.migration?.bonded),
      paid: Boolean(state.status.migration?.paid),
      eligibleCount: state.status.migration?.eligibleCount ?? 0,
      progressPercent: state.status.migration?.progressPercent ?? null,
      solRaised: state.status.migration?.solRaised ?? null,
      solTarget: state.status.migration?.solTarget ?? null,
      bonusAmount: cfg.migrationBonusAmount,
      bonusAmountLabel: `${formatInteger(cfg.migrationBonusAmount)} ${ticker}`,
      bonusSupplyPercentLabel: formatSupplyPercent(
        (cfg.migrationBonusAmount / PUMP_TOTAL_SUPPLY) * 100,
      ),
      minCallouts: cfg.migrationMinCallouts,
    },
    sources: {
      pumpFun: {
        enabled: Boolean(state.status.pumpIngest?.enabled),
        connected: Boolean(state.status.pumpIngest?.connected),
      },
      axiom: {
        enabled: Boolean(state.status.axiomIngest?.enabled),
        connected: Boolean(state.status.axiomIngest?.connected),
      },
    },
    telegram: {
      connected: state.status.telegramConnected,
      publicUrl: publicEnv("NEXT_PUBLIC_TELEGRAM_URL"),
    },
    social: {
      xUrl: publicEnv("NEXT_PUBLIC_X_URL"),
    },
    windowCallouts,
    rounds,
    migrations: state.migrations.map((m) => mapMigration(m, addressTemplate)),
    messages: state.messages.slice(0, 40).map((m) => ({
      id: m.id,
      kind: m.kind,
      text: m.text,
      createdAt: m.createdAt,
    })),
    activeRound: activeAudit
      ? mapRound(activeAudit, numberById.get(activeAudit.id) ?? 0, addressTemplate)
      : null,
  }
}
