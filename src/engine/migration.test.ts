import { describe, expect, it } from "vitest"
import { buildMigrationCandidates, selectMigrationWinner } from "@/engine/migration"
import { isCoinMigrated } from "@/lib/coin"
import type { Callout } from "@/engine/types"

const walletA = "GC9gKkJjieLPTqDRtm3u6KzL7mhVvMdM4DfMa7aV44ke"
const walletB = "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"

function callout(partial: Partial<Callout> & Pick<Callout, "id" | "wallet" | "callerUsername">): Callout {
  return {
    token: "CC",
    capturedAt: "2026-09-19T17:00:00.000Z",
    source: "pump-fun",
    ...partial,
  }
}

describe("migration eligibility", () => {
  it("requires at least N accepted callouts per wallet", () => {
    const rows = buildMigrationCandidates(
      [
        callout({ id: "1", wallet: walletA, callerUsername: "@alpha" }),
        callout({ id: "2", wallet: walletA, callerUsername: "@alpha" }),
        callout({ id: "3", wallet: walletB, callerUsername: "@beta" }),
        callout({ id: "4", wallet: walletB, callerUsername: "@beta" }),
        callout({ id: "5", wallet: walletB, callerUsername: "@beta" }),
      ],
      3,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ wallet: walletB, calloutCount: 3, callerUsername: "@beta" })
  })

  it("picks a CSPRNG winner from the holder pool", () => {
    const candidates = buildMigrationCandidates(
      [
        callout({ id: "1", wallet: walletA, callerUsername: "@alpha" }),
        callout({ id: "2", wallet: walletA, callerUsername: "@alpha" }),
        callout({ id: "3", wallet: walletA, callerUsername: "@alpha" }),
        callout({ id: "4", wallet: walletB, callerUsername: "@beta" }),
        callout({ id: "5", wallet: walletB, callerUsername: "@beta" }),
        callout({ id: "6", wallet: walletB, callerUsername: "@beta" }),
      ],
      3,
    )
    const selection = selectMigrationWinner(candidates, new Date("2026-09-19T18:00:00.000Z"), {
      int: () => 1,
      bytes: () => Buffer.alloc(32, 7),
    })
    expect(selection.index).toBe(1)
    expect(selection.winner.wallet).toBe(walletA)
    expect(selection.entropyHex).toHaveLength(64)
  })

  it("detects Pump migration flags", () => {
    expect(isCoinMigrated({ complete: true })).toBe(true)
    expect(isCoinMigrated({ raydium_pool: "pool111" })).toBe(true)
    expect(isCoinMigrated({ pump_swap_pool: "pool222" })).toBe(true)
    expect(isCoinMigrated({ complete: false })).toBe(false)
  })
})
