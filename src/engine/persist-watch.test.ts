import { describe, expect, it } from "vitest"
import { mergePersistedWatch, parseMintFromTelegramHtml, parseMintsFromTelegramHtml, parseQualifiedBoardRef, preferMint, siteUrlWithBoardRef } from "@/engine/persist-watch"
import { AIDEN_MINT } from "@/lib/coin"

describe("persist-watch", () => {
  it("extracts a mint from Pump and Solscan URLs in intro HTML", () => {
    const html = `Mint: <a href="https://solscan.io/account/${AIDEN_MINT}">4i5F…pump</a>
• <a href="https://pump.fun/coin/${AIDEN_MINT}">Pump.fun</a>`
    expect(parseMintFromTelegramHtml(html)).toBe(AIDEN_MINT)
  })

  it("falls back to a pump-suffix mint when the caption lost its links", () => {
    expect(parseMintFromTelegramHtml(`Mint: ${AIDEN_MINT}`)).toBe(AIDEN_MINT)
    expect(parseMintFromTelegramHtml("Mint: not set yet")).toBeNull()
    expect(
      parseMintFromTelegramHtml(
        "SHILL\nSpeak up and take your money\n\nWaiting for SHILL tech to be live...\n\n• Website: https://callout-beta.vercel.app",
      ),
    ).toBeNull()
  })

  it("prefers the live mint when an old pump URL is still in the pin", () => {
    const beluga = "3FZKytE87Psjb2jt8wzN53YjyiNLwUPruff2gxt1pump"
    const test = "7hD7rBygiLY22G9MGj2qUGAET39Nx5F5AZVjEdbxpump"
    const html = `• <a href="https://pump.fun/coin/${beluga}">Pump.fun</a>
Mint: <a href="https://solscan.io/account/${test}">7hD7…pump</a>`
    expect(parseMintFromTelegramHtml(html)).toBe(beluga)
    expect(parseMintsFromTelegramHtml(html)).toEqual([beluga, test])
    expect(preferMint(parseMintsFromTelegramHtml(html), test)).toBe(test)
  })

  it("reads and writes the QUALIFIED board id on the website hash", () => {
    const href = siteUrlWithBoardRef("https://callout-beta.vercel.app", {
      qid: 801,
      qfp: "abc123def456",
    })
    expect(href).toBe("https://callout-beta.vercel.app#qid=801&qfp=abc123def456")
    expect(parseQualifiedBoardRef(href)).toEqual({
      qualifiedTelegramId: 801,
      qualifiedTelegramIds: [801],
      qualifiedFingerprintHash: "abc123def456",
      qualifiedCount: null,
      lastSnapshotAt: null,
      nextSnapshotAt: null,
      snapshotClaimId: null,
      schedulerPaused: null,
      rounds: [],
      migrationPaid: null,
      callouts: [],
      generation: null,
    })
    expect(parseQualifiedBoardRef("https://callout-beta.vercel.app/")).toEqual({
      qualifiedTelegramId: null,
      qualifiedTelegramIds: [],
      qualifiedFingerprintHash: null,
      qualifiedCount: null,
      lastSnapshotAt: null,
      nextSnapshotAt: null,
      snapshotClaimId: null,
      schedulerPaused: null,
      rounds: [],
      migrationPaid: null,
      callouts: [],
      generation: null,
    })
  })

  it("round-trips lastSnapshotAt and compact payout rounds on the website hash", () => {
    const at = "2026-09-20T12:30:00.000Z"
    const href = siteUrlWithBoardRef("https://callout-beta.vercel.app", {
      snap: at,
      rounds: [
        {
          id: "snap_paid",
          at,
          n: 3,
          s: "partial_failure",
          a: 2_500_000,
          tok: "TEST",
          L: { u: "@ZestFlashTenor", w: "CMNQ8HN", sig: "3RWyNx", st: "confirmed" },
          R: { u: "@lazaza3g", w: "GhKA5E", st: "pending" },
        },
      ],
    })
    expect(href).toContain("snap=")
    expect(href).toContain("r=")
    const parsed = parseQualifiedBoardRef(href)
    expect(parsed.lastSnapshotAt).toBe(at)
    expect(parsed.rounds).toHaveLength(1)
    expect(parsed.rounds[0]?.L?.u).toBe("@ZestFlashTenor")
    expect(parsed.rounds[0]?.R?.u).toBe("@lazaza3g")
  })

  it("keeps a full-wallet payout round on the website hash", () => {
    const href = siteUrlWithBoardRef("https://callout-beta.vercel.app", {
      snap: "2026-09-20T14:01:55.362Z",
      rounds: [
        {
          id: "snap_1542ca633983014b",
          at: "2026-09-20T14:01:55.362Z",
          n: 28,
          s: "partial_failure",
          a: 2_500_000,
          tok: "BELUGA",
          L: {
            u: "@Di_Beliver",
            w: "62HQdwyWm27X8t5pXzEW7NuwVWmqWDqWwyM2xr8VjWPv",
            st: "failed",
          },
          R: {
            u: "@adammilcar",
            w: "GXzowPBLS8et3Edm3iTUHHkGmEVpcdkJgx2QF9ksNYBu",
            st: "failed",
          },
        },
      ],
    })
    expect(href).toContain("r=")
    const parsed = parseQualifiedBoardRef(href)
    expect(parsed.rounds).toHaveLength(1)
    expect(parsed.rounds[0]?.L?.w).toBe("62HQdwyWm27X8t5pXzEW7NuwVWmqWDqWwyM2xr8VjWPv")
    expect(parsed.rounds[0]?.R?.u).toBe("@adammilcar")
  })

  it("round-trips the shared snapshot deadline and pause flag", () => {
    const next = new Date(Date.now() + 12 * 60_000).toISOString()
    const href = siteUrlWithBoardRef("https://callout-beta.vercel.app", {
      next,
      paused: true,
    })
    expect(href).toContain("p=1")
    expect(href).not.toContain("nxt=")
    const paused = parseQualifiedBoardRef(href)
    expect(paused.schedulerPaused).toBe(true)
    expect(paused.nextSnapshotAt).toBeNull()

    const live = siteUrlWithBoardRef("https://callout-beta.vercel.app", {
      next,
      paused: false,
    })
    expect(live).toContain("p=0")
    expect(live).toContain("nxt=")
    const parsed = parseQualifiedBoardRef(live)
    expect(parsed.schedulerPaused).toBe(false)
    expect(parsed.nextSnapshotAt).toBeTruthy()
    expect(Math.abs(Date.parse(parsed.nextSnapshotAt!) - Date.parse(next))).toBeLessThan(2_000)
  })

  it("round-trips bond-lottery settlement on the website hash", () => {
    const href = siteUrlWithBoardRef("https://callout-beta.vercel.app", { paid: true })
    expect(href).toBe("https://callout-beta.vercel.app#mig=1")
    expect(parseQualifiedBoardRef(href).migrationPaid).toBe(true)
    expect(parseQualifiedBoardRef("https://callout-beta.vercel.app#p=0").migrationPaid).toBeNull()
  })

  it("keeps a short list of QUALIFIED telegram ids for delete-repost", () => {
    const href = siteUrlWithBoardRef("https://callout-beta.vercel.app", {
      qid: 105,
      qids: [101, 98],
    })
    expect(href).toBe("https://callout-beta.vercel.app#qid=105.101.98")
    expect(parseQualifiedBoardRef(href).qualifiedTelegramIds).toEqual([105, 101, 98])
    expect(parseQualifiedBoardRef(href).qualifiedTelegramId).toBe(105)
  })

  it("round-trips the QUALIFIED caller count", () => {
    const href = siteUrlWithBoardRef("https://callout-beta.vercel.app", { qn: 7 })
    expect(href).toBe("https://callout-beta.vercel.app#qn=7")
    expect(parseQualifiedBoardRef(href).qualifiedCount).toBe(7)
  })

  it("round-trips compact window callers on the website hash", () => {
    const href = siteUrlWithBoardRef("https://callout-beta.vercel.app", {
      callouts: [
        {
          i: "pump_a",
          u: "@alpha",
          w: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
          t: "2026-09-20T14:10:00.000Z",
          s: "pump-fun",
        },
        {
          i: "pump_b",
          u: "@beta",
          w: "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
          t: "2026-09-20T14:11:00.000Z",
        },
      ],
    })
    expect(href).toContain("c=")
    const parsed = parseQualifiedBoardRef(href)
    expect(parsed.callouts).toHaveLength(2)
    expect(parsed.callouts.map((row) => row.u)).toEqual(["@alpha", "@beta"])
    expect(parsed.callouts[0]?.w).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")
  })

  it("round-trips a snapshot claim id on the website hash", () => {
    const href = siteUrlWithBoardRef("https://callout-beta.vercel.app", {
      snapshotClaimId: "lm0claim-abcd",
    })
    expect(href).toContain("sid=lm0claim-abcd")
    expect(parseQualifiedBoardRef(href).snapshotClaimId).toBe("lm0claim-abcd")
  })

  it("merges rounds and lifetime so empty isolate flushes cannot wipe history", () => {
    const mint = AIDEN_MINT
    const previous = {
      mint,
      ticker: "AIDEN",
      name: "Aiden",
      rounds: [
        {
          id: "snap_1",
          at: "2026-09-20T20:54:48.243Z",
          n: 1,
          s: "partial_failure" as const,
          a: 2500000,
          tok: "AIDEN",
          L: { u: "@ToxicRuralAphid", w: "DfBJz4PQ44bUsjKUQcjwyqd2YLfM38pozPwKammJao4D", s: "fomo" },
          R: { u: "@ToxicRuralAphid", w: "DfBJz4PQ44bUsjKUQcjwyqd2YLfM38pozPwKammJao4D", s: "fomo" },
        },
      ],
      lifetimeCallouts: [
        {
          i: "fomo_family_1",
          u: "@ToxicRuralAphid",
          w: "DfBJz4PQ44bUsjKUQcjwyqd2YLfM38pozPwKammJao4D",
          t: "2026-09-20T19:48:10.091Z",
          s: "fomo",
        },
      ],
      callouts: [
        {
          i: "fomo_family_1",
          u: "@ToxicRuralAphid",
          w: "DfBJz4PQ44bUsjKUQcjwyqd2YLfM38pozPwKammJao4D",
          t: "2026-09-20T19:48:10.091Z",
          s: "fomo",
        },
      ],
    }
    const next = mergePersistedWatch(
      {
        mint,
        ticker: "AIDEN",
        name: "Aiden",
        lastSnapshotAt: "2026-09-20T21:44:22.839Z",
        rounds: [],
        callouts: [],
        lifetimeCallouts: [
          {
            i: "pump_1",
            u: "@HalvedFewCloak",
            w: "11111111111111111111111111111111",
            t: "2026-09-20T22:00:00.000Z",
            s: "pump-fun",
          },
        ],
      },
      previous,
    )
    expect(next.rounds).toHaveLength(1)
    expect(next.rounds?.[0]?.L?.s).toBe("fomo")
    expect(next.lifetimeCallouts?.map((row) => row.i).sort()).toEqual(["fomo_family_1", "pump_1"])
    // Window callouts older than the new snapshot cursor are pruned.
    expect(next.callouts).toEqual([])
  })

  it("a later write cannot restore history from before a mint wipe", () => {
    const mint = AIDEN_MINT
    const wipedAt = "2026-09-21T18:00:00.000Z"
    const previous = {
      mint,
      ticker: "T",
      name: null,
      lastSnapshotAt: "2026-09-21T17:00:00.000Z",
      nextSnapshotAt: "2026-09-21T17:12:00.000Z",
      rounds: [
        {
          id: "old",
          at: "2026-09-21T17:00:00.000Z",
          n: 1,
          s: "confirmed" as const,
          a: 1,
          tok: "T",
        },
      ],
      callouts: [
        { i: "c1", u: "@a", w: "11111111111111111111111111111111", t: "2026-09-21T16:00:00.000Z" },
      ],
      lifetimeCallouts: [
        { i: "c1", u: "@a", w: "11111111111111111111111111111111", t: "2026-09-21T16:00:00.000Z" },
      ],
    }
    const wiped = mergePersistedWatch(
      {
        mint,
        ticker: "T",
        name: null,
        wipedAt,
        rounds: [],
        callouts: [],
        lifetimeCallouts: [],
        lastSnapshotAt: null,
      },
      previous,
    )
    expect(wiped.wipedAt).toBe(wipedAt)
    expect(wiped.rounds).toEqual([])
    expect(wiped.callouts).toEqual([])
    expect(wiped.lifetimeCallouts).toEqual([])
    expect(wiped.lastSnapshotAt).toBeNull()
    expect(wiped.nextSnapshotAt).toBeNull()

    const resurrected = mergePersistedWatch(
      {
        mint,
        ticker: "T",
        name: null,
        lastSnapshotAt: "2026-09-21T17:00:00.000Z",
        rounds: previous.rounds,
        callouts: previous.callouts,
        lifetimeCallouts: previous.lifetimeCallouts,
      },
      wiped,
    )
    expect(resurrected.rounds).toEqual([])
    expect(resurrected.callouts).toEqual([])
    expect(resurrected.lifetimeCallouts).toEqual([])
    expect(resurrected.lastSnapshotAt).toBeNull()
    expect(resurrected.nextSnapshotAt).toBeNull()
    expect(resurrected.wipedAt).toBe(wipedAt)
  })

  it("drops unminted FOMO-family injects that belong to another coin", () => {
    const mint = AIDEN_MINT
    const merged = mergePersistedWatch(
      {
        mint,
        ticker: "AIDEN",
        name: null,
        wipedAt: "2026-09-21T18:00:00.000Z",
        callouts: [
          {
            i: "fomo_family_suicat",
            u: "@x",
            w: "11111111111111111111111111111111",
            t: "2026-09-21T19:00:00.000Z",
            s: "fomo",
          },
          {
            i: "pump_ok",
            u: "@y",
            w: "22222222222222222222222222222222",
            t: "2026-09-21T19:01:00.000Z",
            s: "pump-fun",
            m: mint,
          },
        ],
      },
      null,
    )
    expect(merged.callouts?.map((row) => row.i)).toEqual(["pump_ok"])
  })
})
