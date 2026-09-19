import { pickIndex, type SecureRandom, nodeSecureRandom } from "@/lib/crypto-random"
import type { Callout } from "@/engine/types"

export type RouletteFrame = {
  token: string
  callerUsername: string
  calloutId: string
  delayMs: number
}

/**
 * Purely visual spin. The winner MUST already be known. Frames are decoration;
 * they cannot change `winner`.
 */
export function buildRouletteFrames(
  pool: Callout[],
  winner: Callout,
  frameCount: number,
  frameDelayMs: number,
  random: SecureRandom = nodeSecureRandom,
): RouletteFrame[] {
  if (frameCount < 1) {
    throw new Error("Roulette needs at least one visual frame")
  }

  const visualPool = pool.length > 0 ? pool : [winner]
  const frames: RouletteFrame[] = []

  for (let i = 0; i < frameCount - 1; i += 1) {
    const pick = visualPool[pickIndex(visualPool.length, random)]
    frames.push({
      token: pick.token,
      callerUsername: pick.callerUsername,
      calloutId: pick.id,
      delayMs: frameDelayMs,
    })
  }

  frames.push({
    token: winner.token,
    callerUsername: winner.callerUsername,
    calloutId: winner.id,
    delayMs: Math.round(frameDelayMs * 1.4),
  })

  return frames
}
