import { describe, expect, it } from "vitest"
import {
  collectPumpCallouts,
  parseCalloutReplies,
  parseHomeFeedNewCallouts,
  parsePumpCallout,
  parsePumpCalloutFeed,
  pumpCalloutApiUrl,
  pumpCalloutListUrl,
  pumpCalloutRepliesUrl,
  pumpHomeFeedNewUrl,
} from "@/engine/pump-feed"
import { AIDEN_MINT } from "@/lib/coin"

describe("pump callout feed", () => {
  it("maps Pump.fun callout/top rows to mint, username, and wallet", () => {
    const rows = parsePumpCalloutFeed({
      callouts: [
        {
          calloutId: "71c22205-7e87-4198-904b-512abdc94d45",
          userId: "GC9gKkJjieLPTqDRtm3u6KzL7mhVvMdM4DfMa7aV44ke",
          coinMint: AIDEN_MINT,
          createdAt: 1789643521265,
          username: "0xmarko77",
          thesis: "Seen this on my fyp. Send it.",
        },
        {
          calloutId: "skip-me",
          userId: "not-a-wallet",
          coinMint: AIDEN_MINT,
          createdAt: 1789643521265,
          username: "broken",
        },
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      calloutId: "71c22205-7e87-4198-904b-512abdc94d45",
      coinMint: AIDEN_MINT,
      userId: "GC9gKkJjieLPTqDRtm3u6KzL7mhVvMdM4DfMa7aV44ke",
      username: "0xmarko77",
      thesis: "Seen this on my fyp. Send it.",
    })
    expect(pumpCalloutApiUrl(AIDEN_MINT)).toContain(`/callout/top/${AIDEN_MINT}`)
    expect(pumpCalloutListUrl(AIDEN_MINT)).toContain(`/callout/list/${AIDEN_MINT}`)
    expect(pumpCalloutListUrl(AIDEN_MINT)).toContain("sortBy=TIMESTAMP")
    expect(pumpHomeFeedNewUrl()).toContain("/home-feed/new?")
  })

  it("parses home-feed/new coin cards (chronological global feed)", () => {
    const rows = parseHomeFeedNewCallouts({
      coins: [
        {
          coinMint: AIDEN_MINT,
          position: {
            walletAddress: "GC9gKkJjieLPTqDRtm3u6KzL7mhVvMdM4DfMa7aV44ke",
            userName: "0xmarko77",
            callout: {
              calloutId: "fresh-1",
              thesis: "newest on mint",
              calloutTimestamp: "2026-09-19T17:11:05.353Z",
            },
          },
        },
        {
          coinMint: "So11111111111111111111111111111111111111112",
          position: {
            walletAddress: "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
            userName: "other",
            callout: {
              calloutId: "other-1",
              thesis: "other mint",
              calloutTimestamp: "2026-09-19T17:11:06.000Z",
            },
          },
        },
      ],
    })
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.calloutId === "fresh-1")).toMatchObject({
      coinMint: AIDEN_MINT,
      username: "0xmarko77",
      thesis: "newest on mint",
      createdAtMs: Date.parse("2026-09-19T17:11:05.353Z"),
      kind: "callout",
      activityId: "fresh-1",
    })
  })

  it("emits each follow-up update as its own activity with the update timestamp", () => {
    const rows = parseHomeFeedNewCallouts({
      coins: [
        {
          coinMint: AIDEN_MINT,
          position: {
            walletAddress: "GC9gKkJjieLPTqDRtm3u6KzL7mhVvMdM4DfMa7aV44ke",
            userName: "0xmarko77",
            callout: {
              calloutId: "orig-1",
              thesis: "first post",
              calloutTimestamp: "2026-09-19T17:00:00.000Z",
              updates: [
                {
                  id: "upd-1",
                  content: "still in",
                  createdAt: "2026-09-19T17:20:00.000Z",
                },
              ],
            },
          },
        },
      ],
    })
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.kind === "callout")).toMatchObject({
      activityId: "orig-1",
      createdAtMs: Date.parse("2026-09-19T17:00:00.000Z"),
      thesis: "first post",
    })
    expect(rows.find((row) => row.kind === "update")).toMatchObject({
      activityId: "upd-1",
      calloutId: "orig-1",
      createdAtMs: Date.parse("2026-09-19T17:20:00.000Z"),
      thesis: "still in",
      userId: "GC9gKkJjieLPTqDRtm3u6KzL7mhVvMdM4DfMa7aV44ke",
    })
  })

  it("treats author replies as callout updates (Pump keeps the original thesis on /callout/top)", () => {
    const base = parsePumpCallout({
      calloutId: "7e60e0f1-e6cd-45a4-a0ad-ac4c2a04348e",
      userId: "BxxTLqebZGDbuuHss9FxAYcCb6gLS1sC4fLkotqBjGaT",
      coinMint: AIDEN_MINT,
      createdAt: Date.parse("2026-09-20T15:50:58.862Z"),
      username: "HalvedFewCloak",
      thesis: "dabihgahh",
    })
    expect(base?.thesis).toBe("dabihgahh")
    const replies = parseCalloutReplies(base!, {
      replies: [
        {
          id: "fa0d46fa-ee7c-4cd6-9d96-af8f0660947d",
          content: "innit",
          createdAt: "2026-09-20T16:12:08.147Z",
          walletAddress: "BxxTLqebZGDbuuHss9FxAYcCb6gLS1sC4fLkotqBjGaT",
          userName: "HalvedFewCloak",
        },
        {
          id: "stranger",
          content: "noise",
          createdAt: "2026-09-20T16:13:00.000Z",
          walletAddress: "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
          userName: "stranger",
        },
      ],
    })
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      activityId: "fa0d46fa-ee7c-4cd6-9d96-af8f0660947d",
      kind: "update",
      thesis: "innit",
      username: "HalvedFewCloak",
      createdAtMs: Date.parse("2026-09-20T16:12:08.147Z"),
    })
    expect(pumpCalloutRepliesUrl("7e60e0f1-e6cd-45a4-a0ad-ac4c2a04348e")).toContain(
      "/callout/7e60e0f1-e6cd-45a4-a0ad-ac4c2a04348e/replies",
    )
  })

  it("unwraps nested callout objects and ignores other mints in a mixed feed", () => {
    const nested = parsePumpCallout({
      callout: {
        calloutId: "shape",
        userId: "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        coinMint: AIDEN_MINT,
        createdAt: 1789643521265,
        userName: "ShapeFN",
      },
    })
    expect(nested?.username).toBe("ShapeFN")
    const rows = collectPumpCallouts({
      coins: [
        { coinMint: "So11111111111111111111111111111111111111112", calloutId: "nope" },
        {
          callout: {
            calloutId: "aiden-1",
            userId: "GC9gKkJjieLPTqDRtm3u6KzL7mhVvMdM4DfMa7aV44ke",
            coinMint: AIDEN_MINT,
            createdAt: 1789643521265,
            username: "0xmarko77",
          },
        },
      ],
    })
    expect(rows.some((row) => row.calloutId === "aiden-1")).toBe(true)
  })
})
