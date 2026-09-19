import { describe, expect, it } from "vitest"
import { generateWallet, isValidWallet, normalizeCallout } from "@/engine/collector"

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
})
