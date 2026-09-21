import { describe, expect, it } from "vitest"
import { FORBIDDEN_PUBLIC_COMMANDS, ignoreInboundUpdate, isForbiddenPublicCommand } from "@/telegram/commands"
import {
  bondProgress,
  channelIntro,
  qualifiedCaller,
  rouletteSelected,
  snapshotAnnouncement,
  snapshotPayout,
  withBondProgress,
  withPreBondFomoNotice,
  PRE_BOND_FOMO_NOTICE,
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
      snapshotNumber: 1,
    })
    expect(final.text).toContain("SNAPSHOT #1")
    expect(final.text).not.toContain("PAYOUT")
    expect(final.text).toContain("@username")
    expect(final.text).toContain("@alpha")
    expect(final.text).toContain("Next snapshot")
    expect(final.html).toContain("href=")
    expect(final.text).not.toMatch(/\/status|\/balance|\/config/)

    const twelfth = snapshotPayout({
      lastCallout: callout,
      rouletteWinner: { ...callout, id: "a", callerUsername: "@alpha" },
      lastTx: tx,
      rouletteTx: { ...tx, kind: "last_callout" },
      allocationAmount: 100,
      distributionToken: "BONK",
      snapshotMinMs: 5 * 60_000,
      snapshotMaxMs: 15 * 60_000,
      snapshotNumber: 12,
    })
    expect(twelfth.text).toContain("SNAPSHOT #12")
  })

  it("labels FOMO and Pump.fun callout sources on payout copy", () => {
    const fomo = { ...callout, source: "fomo" }
    const pump = { ...callout, id: "p", callerUsername: "@pumpuser", source: "pump-fun" }
    const selected = rouletteSelected(fomo)
    expect(selected.text).toContain("@username · via FOMO")

    const final = snapshotPayout({
      lastCallout: fomo,
      rouletteWinner: pump,
      lastTx: tx,
      rouletteTx: { ...tx, kind: "last_callout", callerUsername: "@pumpuser" },
      allocationAmount: 100,
      distributionToken: "BONK",
      snapshotMinMs: 5 * 60_000,
      snapshotMaxMs: 15 * 60_000,
      snapshotNumber: 1,
    })
    expect(final.text).toContain("@username · via FOMO")
    expect(final.text).toContain("@pumpuser · via Pump.fun")
  })

  it("formats the permanent channel intro without control affordances", () => {
    const intro = channelIntro({
      tokenName: "The Day Trader",
      ticker: "AIDEN",
      mint: "4i5FqkfYDAPcEVcXyuVyaaBcz3bpwJPqDkmaF36kpump",
      windowLabel: "5–15 minutes",
      siteUrl: "https://callout-beta.vercel.app",
      telegramUrl: "https://t.me/example",
      xUrl: "https://x.com/example",
      pumpUrl: "https://pump.fun/coin/4i5FqkfYDAPcEVcXyuVyaaBcz3bpwJPqDkmaF36kpump",
    })
    expect(intro.kind).toBe("intro")
    expect(intro.text).toContain("SHILL")
    expect(intro.text).toContain("Speak up and take your money")
    expect(intro.text).not.toContain("Token:")
    expect(intro.text).toContain("Website")
    expect(intro.html).toContain("href=")
    expect(intro.text.indexOf("Mint:")).toBeGreaterThan(
      intro.text.indexOf("In a world where nothing matters"),
    )
    expect(intro.text.indexOf("Links")).toBeGreaterThan(intro.text.indexOf("Mint:"))
    expect(intro.text).not.toMatch(/\/pause|\/admin/)
    const fatSite = `https://callout-beta.vercel.app#qid=801&qfp=${"ab".repeat(8)}&qn=1&c=${"x".repeat(1400)}`
    const fat = channelIntro({
      tokenName: "Test",
      ticker: "TEST",
      mint: "BKfdpRHgMUnZiLzBQjts6XimqrRedZVvxEjFttsHpump",
      windowLabel: "5–15 minutes",
      siteUrl: fatSite,
      telegramUrl: "https://t.me/example",
      pumpUrl: "https://pump.fun/coin/BKfdpRHgMUnZiLzBQjts6XimqrRedZVvxEjFttsHpump",
    })
    expect(fat.html.length).toBeGreaterThan(1024)

    const waiting = channelIntro({
      tokenName: null,
      ticker: "SHILL",
      mint: null,
      windowLabel: "5–15 minutes",
      siteUrl: "https://callout-beta.vercel.app#qid=801&snap=2026-09-20T12:00:00.000Z",
      telegramUrl: "https://t.me/example",
      pumpUrl: "https://pump.fun/coin/BKfdpRHgMUnZiLzBQjts6XimqrRedZVvxEjFttsHpump",
    })
    expect(waiting.text).toContain("Waiting for SHILL tech to be live...")
    expect(waiting.text).not.toContain("Mint:")
    expect(waiting.text).not.toContain("pump.fun/coin/")
    expect(waiting.text).not.toContain("BKfdp")
    expect(waiting.text).not.toContain("qid=")
    expect(waiting.html).toContain("https://callout-beta.vercel.app")
    expect(waiting.html).not.toContain("qid=801")
    expect(waiting.text).not.toContain("pre-bond")
  })

  it("pins the FOMO wallet notice on a pre-bond intro", () => {
    const intro = channelIntro({
      tokenName: "SUI CAT",
      ticker: "SUICAT",
      mint: "AP5YnCZRFHayveJ1zSSWeGpB1Hps4v8pLJ6ASmXLMD6M",
      windowLabel: "5–15 minutes",
      siteUrl: "https://www.shilltech.xyz",
      telegramUrl: "https://t.me/example",
      pumpUrl: "https://pump.fun/coin/AP5YnCZRFHayveJ1zSSWeGpB1Hps4v8pLJ6ASmXLMD6M",
      preBond: true,
    })
    expect(intro.text).toContain(PRE_BOND_FOMO_NOTICE)
    expect(intro.text.indexOf("Mint:")).toBeGreaterThan(intro.text.indexOf("pre-bond"))
    const compact = channelIntro({
      tokenName: "SUI CAT",
      ticker: "SUICAT",
      mint: "AP5YnCZRFHayveJ1zSSWeGpB1Hps4v8pLJ6ASmXLMD6M",
      windowLabel: "5–15 minutes",
      siteUrl: "https://www.shilltech.xyz",
      preBond: true,
      compact: true,
    })
    expect(compact.text).toContain(PRE_BOND_FOMO_NOTICE)
    expect(compact.text).not.toContain("In a world where nothing matters")
    expect(compact.html.length).toBeLessThan(1024)
  })

  it("names the callout platform on the qualified board", () => {
    const fomo = { ...callout, source: "fomo", callerUsername: "@beta", thesis: "chart looks ready" }
    const pump = { ...callout, id: "p", source: "pump-fun" }
    const qualified = qualifiedCaller({ callouts: [pump, fomo], latest: fomo })
    expect(qualified.text).toContain("@beta")
    expect(qualified.text).toContain("via FOMO")
    expect(qualified.text.indexOf("via FOMO")).toBeGreaterThan(qualified.text.indexOf("@beta"))
    expect(qualified.text).toContain("@username · Pump.fun")
    expect(qualified.text).toContain("@beta · FOMO")
  })

  it("formats qualified-caller and bond-progress notices", () => {
    const qualified = qualifiedCaller({
      callouts: [callout, { ...callout, id: "e", callerUsername: "@beta", thesis: "chart looks ready" }],
      latest: { ...callout, id: "e", callerUsername: "@beta", thesis: "chart looks ready" },
    })
    expect(qualified.kind).toBe("qualified")
    expect(qualified.text).toContain("🗣️")
    expect(qualified.text).toContain("QUALIFIED")
    expect(qualified.text).toContain("@beta")
    expect(qualified.text).toContain("chart looks ready")
    expect(qualified.text).toContain("@username")
    expect(qualified.text).toContain("`7xK...AsU`")
    expect(qualified.text.indexOf("`7xK...AsU`")).toBeGreaterThan(qualified.text.indexOf("@beta"))
    expect(qualified.text.indexOf("chart looks ready")).toBeGreaterThan(
      qualified.text.indexOf("`7xK...AsU`"),
    )
    expect(qualified.text.split("`7xK...AsU`")).toHaveLength(2)
    expect(qualified.html).toContain("solscan.io/account/")
    expect(qualified.text).toContain("Eligible this snapshot: 2")
    expect(qualified.text).not.toContain("✅")
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

  it("appends the FOMO wallet notice only while pre-bond", () => {
    const base = qualifiedCaller({ callouts: [callout] })
    expect(withPreBondFomoNotice(base, false).text).toBe(base.text)
    const noted = withPreBondFomoNotice(base, true)
    expect(noted.text).toContain(PRE_BOND_FOMO_NOTICE)
    expect(withPreBondFomoNotice(noted, true).text).toBe(noted.text)
  })
})
