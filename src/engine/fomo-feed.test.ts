import { describe, expect, it } from "vitest"
import {
  fomoAlertsWsUrl,
  parseFomoThesis,
  thesisBodyFromAlertText,
} from "@/engine/fomo-feed"
import { FomoThesesPoller } from "@/engine/fomo-poller"
import { DEFAULT_CONFIG } from "@/engine/store"
import { AIDEN_MINT } from "@/lib/coin"

const walletA = "FdqyMANc64kAkqsA8rioKv4p1Umg6wrME7y4mQkkjC1S"

describe("fomo-feed", () => {
  it("parses FOMO app WS thesis alerts", () => {
    const row = parseFomoThesis(
      {
        type: "alert",
        alertType: "thesis",
        id: "alrt_1",
        trader: "Jrock_",
        tokenAddress: AIDEN_MINT,
        chain: "solana",
        chainId: 1399811149,
        userId: "a1dc0146-3f7c-55dc-ab36-e693b10f11f6",
        text: "Jrock_ posted a thesis on $AIDEN: HOLD TILL IT TURNS TO GOLD",
        ts: Date.parse("2026-09-20T18:10:00.000Z"),
      },
      AIDEN_MINT,
    )
    expect(row).toMatchObject({
      traderHandle: "Jrock_",
      thesis: "HOLD TILL IT TURNS TO GOLD",
      tokenAddress: AIDEN_MINT,
    })
    expect(thesisBodyFromAlertText("x posted a thesis on $CATE: Yooo", "x")).toBe("Yooo")
    expect(fomoAlertsWsUrl({ apiKey: "k" })).toContain("/ws/alerts?")
    expect(fomoAlertsWsUrl({ apiKey: "k" })).toContain("type=thesis")
  })
})

describe("FomoThesesPoller", () => {
  it("ingests theses from unmetered WS (never hits /v2/thesis)", async () => {
    const ingested: Array<{ wallet: string; thesis?: string }> = []
    const fetches: string[] = []

    class FakeWS {
      static OPEN = 1
      readyState = 1
      onmessage: ((ev: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: (() => void) | null = null
      constructor(public url: string) {
        setTimeout(() => {
          this.onmessage?.({
            data: JSON.stringify({ type: "welcome", stream: "alerts" }),
          })
          this.onmessage?.({
            data: JSON.stringify({
              type: "alert",
              alertType: "thesis",
              id: "alrt_mint",
              trader: "Johnsonszns",
              tokenAddress: AIDEN_MINT,
              chain: "solana",
              text: "Johnsonszns posted a thesis on $AIDEN: bullish",
              ts: Date.parse("2026-09-20T18:10:00.000Z"),
              walletAddress: walletA,
            }),
          })
          this.onmessage?.({
            data: JSON.stringify({
              type: "alert",
              alertType: "thesis",
              id: "alrt_other",
              trader: "other",
              tokenAddress: "OtherMint1111111111111111111111111111111",
              chain: "solana",
              text: "other posted a thesis on $X: no",
              ts: Date.parse("2026-09-20T18:11:00.000Z"),
            }),
          })
          this.onmessage?.({ data: JSON.stringify({ type: "heartbeat" }) })
        }, 5)
      }
      close() {
        this.onclose?.()
      }
    }

    const poller = new FomoThesesPoller(
      (input) => {
        ingested.push({ wallet: input.wallet, thesis: input.thesis })
        return {
          id: input.id ?? "x",
          token: "AIDEN",
          callerUsername: input.callerUsername,
          wallet: input.wallet,
          capturedAt: input.capturedAt ?? new Date().toISOString(),
          source: "fomo",
          thesis: input.thesis,
        }
      },
      () => ({ ...DEFAULT_CONFIG, coinMint: AIDEN_MINT, distributionToken: "AIDEN" }),
      () => 20_000,
      () => new Date("2026-09-20T18:00:00.000Z"),
      async (url) => {
        fetches.push(String(url))
        return new Response("nope", { status: 500 })
      },
      () => true,
      undefined,
      undefined,
      "fapi_test",
      FakeWS as unknown as typeof WebSocket,
      false,
    )

    const rows = await poller.pollOnce(Date.parse("2026-09-20T18:20:00.000Z"))
    expect(rows).toHaveLength(1)
    expect(ingested).toEqual([{ wallet: walletA, thesis: "bullish" }])
    expect(fetches.some((u) => u.includes("/v2/thesis"))).toBe(false)
    expect(poller.status().accepted).toBe(1)
  })
})
