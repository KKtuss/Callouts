import { entropyHex, pickIndex, type SecureRandom, nodeSecureRandom } from "@/lib/crypto-random"
import type { Callout, RecipientSelection } from "@/engine/types"

export function sortCallouts(callouts: Callout[]): Callout[] {
  return [...callouts].sort((a, b) => {
    const time = a.capturedAt.localeCompare(b.capturedAt)
    if (time !== 0) return time
    return a.id.localeCompare(b.id)
  })
}

/**
 * First recipient is deterministic: the last valid callout before the snapshot.
 * Roulette winner is chosen with CSPRNG from the remaining pool (or the sole
 * callout if it is the only candidate). This function is the only place the
 * winner is decided — animation must never call it.
 */
export function selectRecipients(
  callouts: Callout[],
  now: Date = new Date(),
  random: SecureRandom = nodeSecureRandom,
): RecipientSelection {
  if (callouts.length === 0) {
    throw new Error("Cannot select recipients from an empty callout set")
  }

  const ordered = sortCallouts(callouts)
  const lastCallout = ordered[ordered.length - 1]
  const remainder = ordered.filter((callout) => callout.id !== lastCallout.id)
  const roulettePool = remainder.length > 0 ? remainder : [lastCallout]
  const rouletteIndex = pickIndex(roulettePool.length, random)
  const rouletteWinner = roulettePool[rouletteIndex]

  if (!rouletteWinner) {
    throw new Error("Roulette selection produced no winner")
  }

  return {
    lastCallout,
    roulettePool,
    rouletteIndex,
    rouletteWinner,
    entropyHex: entropyHex(random),
    method: "node:crypto.randomInt",
    selectedAt: now.toISOString(),
  }
}
