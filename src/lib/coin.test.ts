import { describe, expect, it } from "vitest"
import {
  AIDEN_MINT,
  bondingCurveProgress,
  parseRealSolLamports,
  PUMP_BOND_TARGET_SOL,
  resolveCalloutToken,
  resolveCoinFromEnv,
} from "@/lib/coin"

describe("coin identity", () => {
  it("treats the pump.fun mint as AIDEN", () => {
    const coin = resolveCoinFromEnv({
      CALLOUT_TOKEN: AIDEN_MINT,
    } as unknown as NodeJS.ProcessEnv)
    expect(coin.distributionToken).toBe("AIDEN")
    expect(coin.coinMint).toBe(AIDEN_MINT)
    expect(coin.coinName).toBe("The Day Trader")
  })

  it("accepts mint, ticker, and $ticker as the same callout coin", () => {
    const config = { distributionToken: "AIDEN", coinMint: AIDEN_MINT }
    expect(resolveCalloutToken(AIDEN_MINT, config)).toBe("AIDEN")
    expect(resolveCalloutToken("$aiden", config)).toBe("AIDEN")
    expect(resolveCalloutToken(undefined, config)).toBe("AIDEN")
    expect(() => resolveCalloutToken("$BONK", config)).toThrow(/only \$AIDEN/i)
  })

  it("computes bonding-curve fill from real SOL reserves", () => {
    expect(parseRealSolLamports({ real_sol_reserves: 42_500_000_000 })).toBe(42_500_000_000)
    const half = bondingCurveProgress({ migrated: false, realSolLamports: 42_500_000_000 })
    expect(half.solTarget).toBe(PUMP_BOND_TARGET_SOL)
    expect(half.progressPercent).toBe(50)
    expect(bondingCurveProgress({ migrated: false, realSolLamports: 85_000_000_000 }).progressPercent).toBe(99)
    expect(bondingCurveProgress({ migrated: true, realSolLamports: 90_000_000_000 }).progressPercent).toBe(100)
  })
})
