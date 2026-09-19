import { describe, expect, it } from "vitest"
import { generateWallet, isValidWallet, normalizeCallout, CalloutCollector } from "@/engine/collector"
import { tokensMatch } from "@/lib/format"

describe("callout collector", () => {
  it("generates wallets that pass the public address check", () => {
    for (let i = 0; i < 50; i += 1) {
      const wallet = generateWallet()
      expect(isValidWallet(wallet)).toBe(true)
    }
  })

  it("rejects malformed callouts before they enter a snapshot window", () => {
    expect(() =>
      normalizeCallout({
        token: "$OK",
        callerUsername: "alpha",
        wallet: "not-a-wallet",
        source: "demo-feed",
      }),
    ).toThrow(/wallet/i)
  })

  it("treats ticker variants as the same coin", () => {
    expect(tokensMatch("bonk", "$BONK")).toBe(true)
    expect(tokensMatch("BONK", "$WIF")).toBe(false)
  })

  it("keeps one callout per username or wallet in a window", () => {
    const collector = new CalloutCollector()
    const windowStart = new Date("2026-09-19T17:00:00.000Z")
    const walletA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    const walletB = "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    const first = collector.ingestUnique(
      {
        token: "AIDEN",
        callerUsername: "alpha",
        wallet: walletA,
        source: "pump-fun",
        capturedAt: "2026-09-19T17:01:00.000Z",
        id: "one",
      },
      windowStart,
    )
    const sameWallet = collector.ingestUnique(
      {
        token: "AIDEN",
        callerUsername: "beta",
        wallet: walletA,
        source: "pump-fun",
        capturedAt: "2026-09-19T17:02:00.000Z",
        id: "two",
      },
      windowStart,
    )
    const sameUser = collector.ingestUnique(
      {
        token: "AIDEN",
        callerUsername: "alpha",
        wallet: walletB,
        source: "pump-fun",
        capturedAt: "2026-09-19T17:03:00.000Z",
        id: "three",
      },
      windowStart,
    )
    expect(first.duplicate).toBe(false)
    expect(sameWallet.duplicate).toBe(true)
    expect(sameUser.duplicate).toBe(true)
    expect(collector.captureWindow(windowStart, new Date("2026-09-19T17:10:00.000Z"))).toHaveLength(1)
  })
})
