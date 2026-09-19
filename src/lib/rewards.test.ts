import { describe, expect, it } from "vitest"
import { sumRewards, type RewardTx } from "@/lib/rewards"

function tx(partial: Partial<RewardTx>): RewardTx {
  return {
    wallet: "wallet1",
    amount: 1_000,
    distributionToken: "SHILL",
    status: "confirmed",
    ...partial,
  }
}

describe("sumRewards", () => {
  it("counts only confirmed sends", () => {
    const totals = sumRewards(
      [
        tx({ amount: 2_500_000 }),
        tx({ amount: 2_500_000, status: "pending" }),
        tx({ amount: 2_500_000, status: "failed" }),
      ],
      "SHILL",
    )

    expect(totals.payouts).toBe(1)
    expect(totals.tokenAmount).toBe(2_500_000)
  })

  it("expresses supply sends as a percent of total supply", () => {
    const totals = sumRewards(
      [tx({ amount: 2_500_000 }), tx({ amount: 2_500_000, wallet: "wallet2" })],
      "SHILL",
    )

    expect(totals.supplyPercent).toBeCloseTo(0.5)
    expect(totals.supplyPercentLabel).toBe("0.50%")
    expect(totals.tokenLabel).toBe("5,000,000 SHILL")
  })

  it("keeps SOL creator rewards separate from supply", () => {
    const totals = sumRewards(
      [tx({ amount: 2_500_000 }), tx({ amount: 1.5, distributionToken: "SOL", wallet: "wallet2" })],
      "SHILL",
    )

    expect(totals.tokenAmount).toBe(2_500_000)
    expect(totals.solAmount).toBe(1.5)
    expect(totals.solLabel).toBe("1.50 SOL")
  })

  it("counts each wallet once", () => {
    const totals = sumRewards([tx({}), tx({}), tx({ wallet: "wallet2" })], "SHILL")
    expect(totals.wallets).toBe(2)
    expect(totals.payouts).toBe(3)
  })

  it("reads zero with no history", () => {
    const totals = sumRewards([], "SHILL")
    expect(totals.tokenLabel).toBe("0 SHILL")
    expect(totals.solLabel).toBe("0.00 SOL")
    expect(totals.supplyPercentLabel).toBe("0%")
  })
})
