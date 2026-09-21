import { entropyHex, pickIndex, type SecureRandom, nodeSecureRandom } from "@/lib/crypto-random"
import type { Callout } from "@/engine/types"

export type MigrationCandidate = {
  wallet: string
  callerUsername: string
  calloutCount: number
  callouts: Callout[]
}

/**
 * Count accepted callouts per wallet since monitoring started.
 * Username is taken from the latest callout for that wallet (Pump ties username ↔ wallet).
 */
export function buildMigrationCandidates(
  callouts: Callout[],
  minCallouts: number,
): MigrationCandidate[] {
  const byWallet = new Map<string, MigrationCandidate>()

  for (const callout of callouts) {
    const wallet = callout.wallet.trim()
    if (!wallet) continue
    const existing = byWallet.get(wallet)
    if (!existing) {
      byWallet.set(wallet, {
        wallet,
        callerUsername: callout.callerUsername,
        calloutCount: 1,
        callouts: [callout],
      })
      continue
    }
    existing.calloutCount += 1
    existing.callouts.push(callout)
    existing.callerUsername = callout.callerUsername
  }

  return [...byWallet.values()]
    .filter((row) => row.calloutCount >= minCallouts)
    .sort((a, b) => b.calloutCount - a.calloutCount || a.wallet.localeCompare(b.wallet))
}

export type MigrationSelection = {
  winner: MigrationCandidate
  pool: MigrationCandidate[]
  index: number
  entropyHex: string
  method: "node:crypto.randomInt"
  selectedAt: string
}

export type MigrationMultiSelection = {
  winners: MigrationCandidate[]
  pool: MigrationCandidate[]
  entropyHex: string
  method: "node:crypto.randomInt"
  selectedAt: string
}

export function selectMigrationWinner(
  candidates: MigrationCandidate[],
  now: Date = new Date(),
  random: SecureRandom = nodeSecureRandom,
): MigrationSelection {
  if (candidates.length === 0) {
    throw new Error("No migration candidates")
  }
  const index = pickIndex(candidates.length, random)
  const winner = candidates[index]
  if (!winner) throw new Error("Migration selection produced no winner")
  return {
    winner,
    pool: candidates,
    index,
    entropyHex: entropyHex(random),
    method: "node:crypto.randomInt",
    selectedAt: now.toISOString(),
  }
}

/** Draw up to `count` unique winners without replacement. */
export function selectMigrationWinners(
  candidates: MigrationCandidate[],
  count: number,
  now: Date = new Date(),
  random: SecureRandom = nodeSecureRandom,
): MigrationMultiSelection {
  if (candidates.length === 0) {
    throw new Error("No migration candidates")
  }
  const want = Math.max(1, Math.min(count, candidates.length))
  const remaining = [...candidates]
  const winners: MigrationCandidate[] = []
  for (let i = 0; i < want; i += 1) {
    const index = pickIndex(remaining.length, random)
    const picked = remaining.splice(index, 1)[0]
    if (!picked) throw new Error("Migration multi-selection produced an empty pick")
    winners.push(picked)
  }
  return {
    winners,
    pool: candidates,
    entropyHex: entropyHex(random),
    method: "node:crypto.randomInt",
    selectedAt: now.toISOString(),
  }
}
