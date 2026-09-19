import { describe, expect, it } from "vitest"
import {
  collectPumpCallouts,
  parseHomeFeedNewCallouts,
  parsePumpCallout,
  parsePumpCalloutFeed,
  pumpCalloutApiUrl,
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
    })
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
