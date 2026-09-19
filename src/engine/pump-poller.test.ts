import { describe, expect, it } from "vitest"
import { PumpCalloutPoller } from "@/engine/pump-poller"
import { DEFAULT_CONFIG } from "@/engine/store"
import { AIDEN_MINT } from "@/lib/coin"
import type { Callout } from "@/engine/types"

const wallet = "GC9gKkJjieLPTqDRtm3u6KzL7mhVvMdM4DfMa7aV44ke"
const windowStart = new Date("2026-09-19T16:00:00.000Z")

function callout(partial: Partial<Callout> = {}): Callout {
  return {
    id: "co_1",
    token: "$AIDEN",
    callerUsername: "@0xmarko77",
    wallet,
    capturedAt: "2026-09-19T16:05:00.000Z",
    source: "pump-fun",
    ...partial,
  }
}

function homeFeedCard(partial: {
  calloutId: string
  coinMint: string
  wallet: string
  username: string
  at: number
  thesis?: string
}) {
  return {
    coinMint: partial.coinMint,
    position: {
      walletAddress: partial.wallet,
      userName: partial.username,
      callout: {
        calloutId: partial.calloutId,
        thesis: partial.thesis ?? "",
        calloutTimestamp: new Date(partial.at).toISOString(),
      },
    },
  }
}

describe("PumpCalloutPoller", () => {
  it("stores mint-filtered home-feed/new callouts and only counts the current window as accepted", async () => {
    const ingested: Array<{ wallet: string; capturedAt?: string }> = []
    const poller = new PumpCalloutPoller(
      (input) => {
        ingested.push({ wallet: input.wallet, capturedAt: input.capturedAt })
        return callout({ wallet: input.wallet, capturedAt: input.capturedAt })
      },
      () => ({ ...DEFAULT_CONFIG, distributionToken: "AIDEN", coinMint: AIDEN_MINT }),
      () => 60_000,
      () => windowStart,
      async (url) => {
        expect(String(url)).toContain("/home-feed/new?")
        return new Response(
          JSON.stringify({
            coins: [
              homeFeedCard({
                calloutId: "old",
                coinMint: AIDEN_MINT,
                wallet,
                username: "oldcaller",
                at: windowStart.getTime() - 60_000,
              }),
              homeFeedCard({
                calloutId: "fresh",
                coinMint: AIDEN_MINT,
                wallet,
                username: "0xmarko77",
                at: windowStart.getTime() + 60_000,
              }),
              homeFeedCard({
                calloutId: "other",
                coinMint: "So11111111111111111111111111111111111111112",
                wallet: "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
                username: "sol",
                at: windowStart.getTime() + 60_000,
              }),
            ],
            nextPageToken: "",
          }),
          { status: 200 },
        )
      },
    )

    const rows = await poller.pollOnce(windowStart.getTime() + 120_000)
    expect(rows).toHaveLength(2)
    expect(ingested).toHaveLength(2)
    expect(ingested.map((row) => row.capturedAt).sort()).toEqual([
      new Date(windowStart.getTime() - 60_000).toISOString(),
      new Date(windowStart.getTime() + 60_000).toISOString(),
    ])
    expect(poller.accepted).toBe(1)
    expect(poller.connected).toBe(true)
  })

  it("counts a second identity in the same window as a duplicate skip", async () => {
    const poller = new PumpCalloutPoller(
      () => {
        throw Object.assign(new Error("Caller already has a callout in this snapshot window"), {
          name: "DuplicateCalloutError",
          existing: callout(),
        })
      },
      () => ({ ...DEFAULT_CONFIG, distributionToken: "AIDEN", coinMint: AIDEN_MINT }),
      () => 60_000,
      () => windowStart,
      async () =>
        new Response(
          JSON.stringify({
            coins: [
              homeFeedCard({
                calloutId: "fresh",
                coinMint: AIDEN_MINT,
                wallet,
                username: "0xmarko77",
                at: windowStart.getTime() + 60_000,
              }),
            ],
            nextPageToken: "",
          }),
          { status: 200 },
        ),
    )

    await poller.pollOnce(windowStart.getTime() + 120_000)
    expect(poller.accepted).toBe(0)
    expect(poller.skipped).toBe(1)
  })
})
