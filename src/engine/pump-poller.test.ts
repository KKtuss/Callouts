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
  updates?: Array<{ id: string; content: string; at: number }>
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
        updates: (partial.updates ?? []).map((update) => ({
          id: update.id,
          content: update.content,
          createdAt: new Date(update.at).toISOString(),
        })),
      },
    },
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function pumpFetch(handler: (href: string) => Response | Promise<Response>) {
  return async (url: string | URL | Request) => {
    const href = String(url)
    if (href.includes("/replies")) return json({ replies: [] })
    return handler(href)
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
      pumpFetch(async (href) => {
        if (href.includes("/callout/top/")) {
          return json({ callouts: [] })
        }
        if (href.includes("/callout/list/")) {
          return json({ callouts: [], nextPageToken: "" })
        }
        expect(href).toContain("/home-feed/new?")
        return json({
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
        })
      }),
    )

    const rows = await poller.pollOnce(windowStart.getTime() + 120_000)
    expect(rows).toHaveLength(2)
    expect(ingested).toHaveLength(2)
    expect(ingested.map((row) => row.capturedAt).sort()).toEqual([
      new Date(windowStart.getTime()).toISOString(),
      new Date(windowStart.getTime() + 60_000).toISOString(),
    ])
    expect(poller.accepted).toBe(2)
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
      pumpFetch(async (href) => {
        if (href.includes("/callout/top/") || href.includes("/callout/list/")) {
          return json({ callouts: [] })
        }
        return json({
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
        })
      }),
    )

    await poller.pollOnce(windowStart.getTime() + 120_000)
    expect(poller.accepted).toBe(0)
    expect(poller.skipped).toBe(1)
  })

  it("ingests mint-scoped callout/top rows even when home-feed/new is empty", async () => {
    const ingested: string[] = []
    const poller = new PumpCalloutPoller(
      (input) => {
        ingested.push(input.id ?? "")
        return callout({ id: input.id, wallet: input.wallet, capturedAt: input.capturedAt })
      },
      () => ({ ...DEFAULT_CONFIG, distributionToken: "AIDEN", coinMint: AIDEN_MINT }),
      () => 60_000,
      () => windowStart,
      pumpFetch(async (href) => {
        if (href.includes("/callout/top/")) {
          return json({
              callouts: [
                {
                  calloutId: "top-1",
                  userId: wallet,
                  coinMint: AIDEN_MINT,
                  createdAt: windowStart.getTime() + 60_000,
                  username: "0xmarko77",
                  thesis: "from top",
                },
              ],
          })
        }
        if (href.includes("/callout/list/")) {
          return json({ callouts: [], nextPageToken: "" })
        }
        return json({ coins: [], nextPageToken: "" })
      }),
    )

    const rows = await poller.pollOnce(windowStart.getTime() + 120_000)
    expect(rows.map((row) => row.calloutId)).toEqual(["top-1"])
    expect(ingested).toEqual(["pump_top-1"])
    expect(poller.accepted).toBe(1)
  })

  it("does not clamp historical Pump rows into a post-snapshot window", async () => {
    const ingested: Array<{ id?: string; capturedAt?: string }> = []
    const poller = new PumpCalloutPoller(
      (input) => {
        ingested.push({ id: input.id, capturedAt: input.capturedAt })
        return callout({ id: input.id, capturedAt: input.capturedAt })
      },
      () => ({ ...DEFAULT_CONFIG, distributionToken: "AIDEN", coinMint: AIDEN_MINT }),
      () => 60_000,
      () => windowStart,
      pumpFetch(async (href) => {
        if (href.includes("/callout/top/")) {
          return json({
              callouts: [
                {
                  calloutId: "old",
                  userId: wallet,
                  coinMint: AIDEN_MINT,
                  createdAt: windowStart.getTime() - 60_000,
                  username: "oldcaller",
                  thesis: "",
                },
                {
                  calloutId: "fresh",
                  userId: wallet,
                  coinMint: AIDEN_MINT,
                  createdAt: windowStart.getTime() + 60_000,
                  username: "0xmarko77",
                  thesis: "live",
                },
              ],
          })
        }
        if (href.includes("/callout/list/")) {
          return json({ callouts: [], nextPageToken: "" })
        }
        return json({ coins: [], nextPageToken: "" })
      }),
      () => true,
      undefined,
      undefined,
      () => false,
    )

    await poller.pollOnce(windowStart.getTime() + 120_000)
    expect(ingested.map((row) => row.id)).toEqual(["pump_fresh"])
    expect(ingested[0]?.capturedAt).toBe(new Date(windowStart.getTime() + 60_000).toISOString())
    expect(poller.accepted).toBe(1)
    expect(poller.skipped).toBe(1)
  })

  it("ingests mint-scoped callout/list rows sorted by TIMESTAMP", async () => {
    const ingested: string[] = []
    const poller = new PumpCalloutPoller(
      (input) => {
        ingested.push(input.id ?? "")
        return callout({ id: input.id, wallet: input.wallet, capturedAt: input.capturedAt })
      },
      () => ({ ...DEFAULT_CONFIG, distributionToken: "AIDEN", coinMint: AIDEN_MINT }),
      () => 60_000,
      () => windowStart,
      pumpFetch(async (href) => {
        if (href.includes("/callout/list/")) {
          expect(href).toContain("sortBy=TIMESTAMP")
          return json({
              callouts: [
                {
                  calloutId: "list-1",
                  userId: wallet,
                  coinMint: AIDEN_MINT,
                  createdAt: windowStart.getTime() + 30_000,
                  username: "0xmarko77",
                  thesis: "from list",
                },
              ],
              nextPageToken: "",
          })
        }
        return json({ callouts: [], coins: [], nextPageToken: "" })
      }),
    )

    const rows = await poller.pollOnce(windowStart.getTime() + 120_000)
    expect(rows.map((row) => row.calloutId)).toEqual(["list-1"])
    expect(ingested).toEqual(["pump_list-1"])
    expect(poller.accepted).toBe(1)
  })

  it("re-qualifies a caller in a later window from a Pump callout update", async () => {
    const ingested: Array<{ id?: string; capturedAt?: string; thesis?: string }> = []
    const poller = new PumpCalloutPoller(
      (input) => {
        ingested.push({ id: input.id, capturedAt: input.capturedAt, thesis: input.thesis })
        return callout({ id: input.id, capturedAt: input.capturedAt, thesis: input.thesis })
      },
      () => ({ ...DEFAULT_CONFIG, distributionToken: "AIDEN", coinMint: AIDEN_MINT }),
      () => 60_000,
      () => windowStart,
      pumpFetch(async (href) => {
        if (href.includes("/callout/top/") || href.includes("/callout/list/")) {
          return json({ callouts: [], nextPageToken: "" })
        }
        return json({
            coins: [
              homeFeedCard({
                calloutId: "orig-1",
                coinMint: AIDEN_MINT,
                wallet,
                username: "0xmarko77",
                at: windowStart.getTime() - 60_000,
                thesis: "first post",
                updates: [
                  {
                    id: "upd-1",
                    content: "still in",
                    at: windowStart.getTime() + 30_000,
                  },
                ],
              }),
            ],
            nextPageToken: "",
        })
      }),
      () => true,
      undefined,
      undefined,
      () => false,
    )

    const rows = await poller.pollOnce(windowStart.getTime() + 120_000)
    expect(rows.map((row) => `${row.kind}:${row.activityId}`).sort()).toEqual([
      "callout:orig-1",
      "update:upd-1",
    ])
    expect(ingested).toEqual([
      {
        id: "pump_upd-1",
        capturedAt: new Date(windowStart.getTime() + 30_000).toISOString(),
        thesis: "still in",
      },
    ])
    expect(poller.accepted).toBe(1)
    expect(poller.skipped).toBe(1)
  })

  it("re-qualifies an author reply on /callout/{id}/replies after a snapshot", async () => {
    const origId = "7e60e0f1-e6cd-45a4-a0ad-ac4c2a04348e"
    const ingested: Array<{ id?: string; thesis?: string }> = []
    const poller = new PumpCalloutPoller(
      (input) => {
        ingested.push({ id: input.id, thesis: input.thesis })
        return callout({ id: input.id, thesis: input.thesis })
      },
      () => ({ ...DEFAULT_CONFIG, distributionToken: "AIDEN", coinMint: AIDEN_MINT }),
      () => 60_000,
      () => windowStart,
      async (url) => {
        const href = String(url)
        if (href.includes(`/callout/${origId}/replies`)) {
          return json({
            replies: [
              {
                id: "fa0d46fa-ee7c-4cd6-9d96-af8f0660947d",
                content: "innit",
                createdAt: new Date(windowStart.getTime() + 30_000).toISOString(),
                walletAddress: wallet,
                userName: "HalvedFewCloak",
              },
              {
                id: "other-user",
                content: "noise",
                createdAt: new Date(windowStart.getTime() + 40_000).toISOString(),
                walletAddress: "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
                userName: "stranger",
              },
            ],
          })
        }
        if (href.includes("/callout/top/")) {
          return json({
            callouts: [
              {
                calloutId: origId,
                userId: wallet,
                coinMint: AIDEN_MINT,
                createdAt: windowStart.getTime() - 60_000,
                username: "HalvedFewCloak",
                thesis: "dabihgahh",
              },
            ],
          })
        }
        return json({ callouts: [], coins: [], nextPageToken: "" })
      },
      () => true,
      undefined,
      undefined,
      () => false,
    )

    const rows = await poller.pollOnce(windowStart.getTime() + 120_000)
    expect(rows.map((row) => `${row.kind}:${row.thesis}`).sort()).toEqual([
      "callout:dabihgahh",
      "update:innit",
    ])
    expect(ingested).toEqual([
      { id: "pump_fa0d46fa-ee7c-4cd6-9d96-af8f0660947d", thesis: "innit" },
    ])
    expect(poller.accepted).toBe(1)
    expect(poller.skipped).toBe(1)
  })
})
