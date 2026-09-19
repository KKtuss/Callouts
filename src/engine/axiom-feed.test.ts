import { describe, expect, it } from "vitest"
import { axiomCalloutsUrl, parseAxiomCallout, parseAxiomCalloutFeed } from "@/engine/axiom-feed"

const wallet = "FHED2iPuSx6tWG51FB4wi7pAFpREVQrF9E5ApFoi53aa"
const mint = "DDVUsN8sDFxbaX6gNBoD44kjZhFETWJnwAn4EX1dpump"

function sample(partial: Record<string, unknown> = {}) {
  return {
    id: "4c45a2e5-f305-4b15-b8c6-2636b4b981d8",
    chain: "sol",
    state: "sold",
    createdAt: "2026-09-19T14:20:49.969Z",
    body: "VAMP RUGGGGGGG",
    userId: "a115fe81-5792-440c-9397-f31f26658a36",
    walletAddress: wallet,
    callerHandle: "callumxzf",
    tokenAddress: mint,
    kind: "callout",
    ...partial,
  }
}

describe("axiom-feed", () => {
  it("maps Axiom callout rows to mint, username, wallet, and body", () => {
    const row = parseAxiomCallout(sample())
    expect(row).toEqual({
      calloutId: "4c45a2e5-f305-4b15-b8c6-2636b4b981d8",
      tokenAddress: mint,
      wallet,
      username: "callumxzf",
      createdAtMs: Date.parse("2026-09-19T14:20:49.969Z"),
      thesis: "VAMP RUGGGGGGG",
      kind: "callout",
      chain: "sol",
      state: "sold",
    })
  })

  it("rejects non-sol chains and invalid wallets", () => {
    expect(parseAxiomCallout(sample({ chain: "bsc" }))).toBeNull()
    expect(parseAxiomCallout(sample({ walletAddress: "0xabc" }))).toBeNull()
    expect(parseAxiomCallout(sample({ kind: "comment" }))).toBeNull()
  })

  it("parses array and wrapped payloads", () => {
    const fromArray = parseAxiomCalloutFeed([sample(), sample({ id: "dup" })])
    expect(fromArray).toHaveLength(2)

    const wrapped = parseAxiomCalloutFeed({ callouts: [sample({ id: "wrapped" })] })
    expect(wrapped[0]?.calloutId).toBe("wrapped")
  })

  it("builds the mint-scoped callouts URL", () => {
    expect(axiomCalloutsUrl(mint)).toBe(
      `https://api8.axiom.trade/callouts?tokenAddress=${encodeURIComponent(mint)}&v=2`,
    )
  })
})
