import { describe, expect, it } from "vitest"
import { selectRecipients } from "@/engine/selection"
import type { Callout } from "@/engine/types"
import type { SecureRandom } from "@/lib/crypto-random"

function callout(partial: Partial<Callout> & Pick<Callout, "id" | "token" | "capturedAt">): Callout {
  return {
    callerUsername: `@${partial.id}`,
    wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    source: "demo-feed",
    ...partial,
  }
}

class ScriptedRandom implements SecureRandom {
  constructor(private readonly ints: number[]) {}
  int(): number {
    const next = this.ints.shift()
    if (next === undefined) throw new Error("Unexpected extra random draw")
    return next
  }
  bytes(size: number): Buffer {
    return Buffer.alloc(size, 7)
  }
}

describe("selectRecipients", () => {
  it("uses the last valid callout before the snapshot as the first recipient", () => {
    const callouts = [
      callout({ id: "a", token: "$TOKEN_A", capturedAt: "2026-09-19T17:02:00.000Z" }),
      callout({ id: "b", token: "$TOKEN_B", capturedAt: "2026-09-19T17:08:00.000Z" }),
      callout({ id: "c", token: "$TOKEN_C", capturedAt: "2026-09-19T17:13:00.000Z" }),
    ]

    const selection = selectRecipients(callouts, new Date("2026-09-19T17:13:01.000Z"), new ScriptedRandom([0]))
    expect(selection.lastCallout.id).toBe("c")
    expect(selection.lastCallout.token).toBe("$TOKEN_C")
  })

  it("chooses the roulette winner with the injected CSPRNG and excludes the last callout", () => {
    const callouts = [
      callout({ id: "a", token: "$TOKEN_A", capturedAt: "2026-09-19T17:02:00.000Z" }),
      callout({ id: "b", token: "$TOKEN_B", capturedAt: "2026-09-19T17:08:00.000Z" }),
      callout({ id: "c", token: "$TOKEN_C", capturedAt: "2026-09-19T17:13:00.000Z" }),
    ]

    const selection = selectRecipients(callouts, new Date(), new ScriptedRandom([1]))
    expect(selection.roulettePool.map((item) => item.id)).toEqual(["a", "b"])
    expect(selection.rouletteIndex).toBe(1)
    expect(selection.rouletteWinner.id).toBe("b")
    expect(selection.method).toBe("node:crypto.randomInt")
    expect(selection.entropyHex).toHaveLength(64)
  })

  it("falls back to the sole callout when the roulette pool would otherwise be empty", () => {
    const only = callout({ id: "solo", token: "$SOLO", capturedAt: "2026-09-19T17:02:00.000Z" })
    const selection = selectRecipients([only], new Date(), new ScriptedRandom([0]))
    expect(selection.lastCallout.id).toBe("solo")
    expect(selection.rouletteWinner.id).toBe("solo")
  })
})
