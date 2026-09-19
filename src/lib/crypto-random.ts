import { randomBytes, randomInt } from "node:crypto"

/**
 * Cryptographically secure random helpers.
 * Selection MUST use this module — never Math.random().
 */
export interface SecureRandom {
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number
  bytes(size: number): Buffer
}

export const nodeSecureRandom: SecureRandom = {
  int(maxExclusive: number) {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`secure random: maxExclusive must be a positive integer, got ${maxExclusive}`)
    }
    return randomInt(0, maxExclusive)
  },
  bytes(size: number) {
    return randomBytes(size)
  },
}

export function pickIndex(length: number, random: SecureRandom = nodeSecureRandom): number {
  return random.int(length)
}

export function entropyHex(random: SecureRandom = nodeSecureRandom, bytes = 32): string {
  return random.bytes(bytes).toString("hex")
}
