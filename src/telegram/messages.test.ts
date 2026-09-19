import { describe, expect, it } from "vitest"
import { FORBIDDEN_PUBLIC_COMMANDS, ignoreInboundUpdate, isForbiddenPublicCommand } from "@/telegram/commands"
import { rouletteSelected, snapshotAnnouncement, snapshotFinal } from "@/telegram/messages"
import type { Callout, DistributionTx } from "@/engine/types"

const callout: Callout = {
  id: "d",
  token: "$TOKEN_D",
  callerUsername: "@username",
  wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  capturedAt: "2026-09-19T17:12:00.000Z",
  source: "demo-feed",
}

const tx: DistributionTx = {
  kind: "roulette",
  calloutId: "d",
  token: "$TOKEN_D",
  callerUsername: "@username",
  wallet: callout.wallet,
  amount: 100,
  distributionToken: "TOKEN",
  signature: "5FjK82aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  explorerUrl: "https://solscan.io/tx/5Fj",
  status: "confirmed",
  submittedAt: "2026-09-19T17:13:10.000Z",
  confirmedAt: "2026-09-19T17:13:12.000Z",
  error: null,
}

describe("public Telegram surface", () => {
  it("treats inbound bot updates as inert", () => {
    const result = ignoreInboundUpdate({ message: { text: "/pause" } })
    expect(result.ignored).toBe(true)
    expect(FORBIDDEN_PUBLIC_COMMANDS).toContain("pause")
    expect(isForbiddenPublicCommand("/admin")).toBe(true)
    expect(isForbiddenPublicCommand("snapshot")).toBe(true)
  })

  it("formats snapshot, roulette, and confirmation copy without control affordances", () => {
    const snapshot = snapshotAnnouncement({
      calloutCount: 27,
      windowStart: new Date("2026-09-19T17:02:00"),
      windowEnd: new Date("2026-09-19T17:13:00"),
    })
    expect(snapshot.text).toContain("SNAPSHOT")
    expect(snapshot.text).toContain("Callouts captured: 27")
    expect(snapshot.text).toContain("Selecting recipients")

    const selected = rouletteSelected(callout)
    expect(selected.text).toContain("SELECTED")
    expect(selected.text).toContain("$TOKEN_D")
    expect(selected.html).toContain("solscan.io/account/")

    const final = snapshotFinal({
      lastCallout: callout,
      rouletteWinner: { ...callout, id: "a", token: "$TOKEN_A" },
      lastTx: tx,
      rouletteTx: { ...tx, kind: "last_callout" },
      allocationAmount: 100,
      distributionToken: "TOKEN",
      snapshotMinMs: 5 * 60_000,
      snapshotMaxMs: 15 * 60_000,
    })
    expect(final.text).toContain("Next snapshot")
    expect(final.html).toContain("href=")
    expect(final.text).not.toMatch(/\/status|\/balance|\/config/)
  })
})
