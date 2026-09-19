import { describe, expect, it } from "vitest"
import { AxiomCalloutPoller } from "@/engine/axiom-poller"
import { DEFAULT_CONFIG } from "@/engine/store"
import type { Callout } from "@/engine/types"

const wallet = "FHED2iPuSx6tWG51FB4wi7pAFpREVQrF9E5ApFoi53aa"
const mint = "DDVUsN8sDFxbaX6gNBoD44kjZhFETWJnwAn4EX1dpump"
const windowStart = new Date("2026-09-19T16:00:00.000Z")

function callout(partial: Partial<Callout> = {}): Callout {
  return {
    id: "co_1",
    token: "$BABYCATE",
    callerUsername: "@callumxzf",
    wallet,
    capturedAt: "2026-09-19T16:05:00.000Z",
    source: "axiom",
    ...partial,
  }
}

function axiomRow(partial: {
  id: string
  at: string
  mint?: string
  wallet?: string
  handle?: string
  body?: string
}) {
  return {
    id: partial.id,
    chain: "sol",
    state: "open",
    createdAt: partial.at,
    body: partial.body ?? "thesis",
    walletAddress: partial.wallet ?? wallet,
    callerHandle: partial.handle ?? "callumxzf",
    tokenAddress: partial.mint ?? mint,
    kind: "callout",
  }
}

describe("AxiomCalloutPoller", () => {
  it("ingests mint callouts and counts only the current window as accepted", async () => {
    const ingested: Array<{ id?: string; wallet: string; source?: string }> = []
    const poller = new AxiomCalloutPoller(
      (input) => {
        ingested.push({ id: input.id, wallet: input.wallet, source: input.source })
        return callout({ wallet: input.wallet, id: input.id })
      },
      () => ({ ...DEFAULT_CONFIG, distributionToken: "BABYCATE", coinMint: mint }),
      () => 60_000,
      () => windowStart,
      async (url, init) => {
        expect(String(url)).toContain(`/callouts?tokenAddress=${encodeURIComponent(mint)}`)
        expect((init?.headers as Record<string, string>).Cookie).toContain("auth-access-token=")
        return new Response(
          JSON.stringify([
            axiomRow({ id: "old", at: "2026-09-19T15:50:00.000Z" }),
            axiomRow({ id: "fresh", at: "2026-09-19T16:05:00.000Z" }),
            axiomRow({
              id: "other",
              at: "2026-09-19T16:05:00.000Z",
              mint: "So11111111111111111111111111111111111111112",
              wallet: "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
              handle: "other",
            }),
          ]),
          { status: 200 },
        )
      },
      () => true,
      undefined,
      undefined,
      "auth-access-token=test; auth-refresh-token=test",
    )

    const rows = await poller.pollOnce(Date.parse("2026-09-19T16:10:00.000Z"))
    expect(rows).toHaveLength(2)
    expect(ingested).toEqual([
      { id: "axiom_fresh", wallet, source: "axiom" },
      { id: "axiom_old", wallet, source: "axiom" },
    ])
    expect(poller.accepted).toBe(1)
    expect(poller.connected).toBe(true)
    expect(poller.status().cookieConfigured).toBe(true)
  })

  it("surfaces auth failures without ingesting", async () => {
    const ingested: string[] = []
    const poller = new AxiomCalloutPoller(
      (input) => {
        ingested.push(input.wallet)
        return callout()
      },
      () => ({ ...DEFAULT_CONFIG, coinMint: mint }),
      () => 60_000,
      () => windowStart,
      async () => new Response("unauthorized", { status: 401 }),
      () => true,
      undefined,
      undefined,
      "auth-access-token=expired",
    )

    await expect(poller.pollOnce()).rejects.toThrow(/auth failed/i)
    expect(ingested).toHaveLength(0)
  })

  it("requires a cookie before polling", async () => {
    const poller = new AxiomCalloutPoller(
      () => callout(),
      () => ({ ...DEFAULT_CONFIG, coinMint: mint }),
      () => 60_000,
      () => windowStart,
      async () => {
        throw new Error("should not fetch")
      },
    )

    const rows = await poller.pollOnce()
    expect(rows).toHaveLength(0)
    expect(poller.lastError).toMatch(/cookie/i)
  })
})
