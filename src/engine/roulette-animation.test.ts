import { describe, expect, it } from "vitest"
import { buildRouletteFrames } from "@/engine/roulette-animation"
import type { Callout } from "@/engine/types"
import type { SecureRandom } from "@/lib/crypto-random"

const winner: Callout = {
  id: "win",
  token: "$BONK",
  callerUsername: "@winner",
  wallet: "4LmXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  capturedAt: "2026-09-19T17:10:00.000Z",
  source: "demo-feed",
}

const pool: Callout[] = [
  {
    id: "a",
    token: "$BONK",
    callerUsername: "@a",
    wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    capturedAt: "2026-09-19T17:02:00.000Z",
    source: "demo-feed",
  },
  {
    id: "b",
    token: "$BONK",
    callerUsername: "@b",
    wallet: "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    capturedAt: "2026-09-19T17:04:00.000Z",
    source: "demo-feed",
  },
  winner,
]

class ZeroRandom implements SecureRandom {
  int(): number {
    return 0
  }
  bytes(size: number): Buffer {
    return Buffer.alloc(size, 1)
  }
}

describe("buildRouletteFrames", () => {
  it("is visual-only and always ends on the preselected winner", () => {
    const frames = buildRouletteFrames(pool, winner, 6, 400, new ZeroRandom())
    expect(frames).toHaveLength(6)
    expect(frames.at(-1)).toMatchObject({
      token: "$BONK",
      callerUsername: "@winner",
      calloutId: "win",
    })
    expect(frames.slice(0, -1).every((frame) => frame.calloutId === "a")).toBe(true)
  })
})
