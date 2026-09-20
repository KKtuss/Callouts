import { describe, expect, it } from "vitest"
import { FORBIDDEN_PUBLIC_COMMANDS, ignoreInboundUpdate, isForbiddenPublicCommand } from "@/telegram/commands"
import {
  bondProgress,
  qualifiedCaller,
  rouletteSelected,
  snapshotAnnouncement,
  snapshotPayout,
  withBondProgress,
} from "@/telegram/messages"
import { progressBar } from "@/lib/format"
import type { Callout, DistributionTx } from "@/engine/types"

const callout: Callout = {
  id: "d",
  token: "$BONK",
  callerUsername: "@username",
  wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  capturedAt: "2026-09-19T17:12:00.000Z",
  source: "demo-feed",
}

const tx: DistributionTx = {
  kind: "roulette",
  calloutId: "d",
  token: "$BONK",
  callerUsername: "@username",
  wallet: callout.wallet,
  amount: 100,
  distributionToken: "BONK",
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
    expect(selected.text).not.toContain("$BONK")
    expect(selected.text).toContain("@username")
    expect(selected.html).toContain("solscan.io/account/")

    const final = snapshotPayout({
      lastCallout: callout,
      rouletteWinner: { ...callout, id: "a", callerUsername: "@alpha" },
      lastTx: tx,
      rouletteTx: { ...tx, kind: "last_callout" },
      allocationAmount: 100,
      distributionToken: "BONK",
      snapshotMinMs: 5 * 60_000,
      snapshotMaxMs: 15 * 60_000,
    })
    expect(final.text).toContain("PAYOUT")
    expect(final.text).toContain("@username")
    expect(final.text).toContain("@alpha")
    expect(final.text).toContain("Next snapshot")
    expect(final.html).toContain("href=")
    expect(final.text).not.toMatch(/\/status|\/balance|\/config/)
  })

  it("formats qualified-caller and bond-progress notices", () => {
    const qualified = qualifiedCaller({
      callouts: [callout, { ...callout, id: "e", callerUsername: "@beta" }],
    })
    expect(qualified.kind).toBe("qualified")
    expect(qualified.text).toContain("QUALIFIED")
    expect(qualified.text).toContain("@username")
    expect(qualified.text).toContain("@beta")
    expect(qualified.text).toContain("Eligible this snapshot: 2")
    expect(qualified.text).not.toContain("$BONK")
    expect(qualified.text).not.toMatch(/\/pause|\/admin/)

    const bond = bondProgress({
      percent: 82,
      solRaised: 69.7,
      solTarget: 85,
      eligibleCount: 2,
      minCallouts: 3,
    })
    expect(bond.kind).toBe("bond")
    expect(bond.text).toContain(progressBar(82))
    expect(bond.text).toContain("82%")
    expect(bond.text).toContain("69.7 / 85.0 SOL")
    expect(bond.text).toContain("Bonus pool: 2 wallets")
    expect(bond.text).not.toContain("AIDEN")
  })

  it("appends bonding progress until the coin is bonded", () => {
    const base = qualifiedCaller({ callouts: [callout] })
    const withBar = withBondProgress(base, {
      percent: 40,
      solRaised: 34,
      solTarget: 85,
    })
    expect(withBar.text).toContain(progressBar(40))
    expect(withBar.text).toContain("40%")
    expect(withBondProgress(base, { percent: 100, solRaised: 85, solTarget: 85 }).text).toBe(
      base.text,
    )
    expect(withBondProgress(base, { percent: 50, solRaised: 40, solTarget: 85, bonded: true }).text).toBe(
      base.text,
    )
  })
})
