import { PUMP_TOTAL_SUPPLY } from "@/lib/coin"
import {
  canonicalToken,
  formatInteger,
  formatSolAmount,
  formatSupplyPercent,
} from "@/lib/format"

/** Minimal shape needed to total a payout — snapshot and bond txs both fit. */
export type RewardTx = {
  wallet: string
  amount: number
  distributionToken: string
  status: "pending" | "confirmed" | "failed"
}

export type RewardTotals = {
  /** Confirmed sends. */
  payouts: number
  /** Distinct wallets paid at least once. */
  wallets: number
  /** Token amount sent from supply. */
  tokenAmount: number
  tokenLabel: string
  supplyPercent: number
  supplyPercentLabel: string
  /** Creator rewards sent in SOL (post-bond). */
  solAmount: number
  solLabel: string
}

export function isSolPayout(distributionToken: string): boolean {
  return canonicalToken(distributionToken) === "SOL"
}

/**
 * Totals every confirmed payout, splitting supply sends from SOL creator
 * rewards. Pending and failed sends are excluded so the public counter only
 * ever counts money that actually landed.
 */
export function sumRewards(
  transactions: RewardTx[],
  ticker: string,
  totalSupply: number = PUMP_TOTAL_SUPPLY,
): RewardTotals {
  const wallets = new Set<string>()
  let payouts = 0
  let tokenAmount = 0
  let solAmount = 0

  for (const tx of transactions) {
    if (tx.status !== "confirmed" || tx.amount <= 0) continue
    payouts += 1
    if (tx.wallet) wallets.add(tx.wallet)
    if (isSolPayout(tx.distributionToken)) {
      solAmount += tx.amount
    } else {
      tokenAmount += tx.amount
    }
  }

  const supplyPercent = totalSupply > 0 ? (tokenAmount / totalSupply) * 100 : 0

  return {
    payouts,
    wallets: wallets.size,
    tokenAmount,
    tokenLabel: `${formatInteger(tokenAmount)} ${ticker}`,
    supplyPercent,
    supplyPercentLabel: formatSupplyPercent(supplyPercent),
    solAmount,
    solLabel: `${formatSolAmount(solAmount)} SOL`,
  }
}
