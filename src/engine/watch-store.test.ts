import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CalloutCollector } from "@/engine/collector"
import { buildMigrationCandidates } from "@/engine/migration"
import { MigrationMonitor } from "@/engine/migration-monitor"
import {
  auditsFromRounds,
  clearPersistedWatch,
  loadPersistedWatch,
  persistWatch,
  type PersistedRound,
} from "@/engine/persist-watch"
import { DEFAULT_CONFIG, EngineStore } from "@/engine/store"
import { MockTreasury } from "@/engine/treasury"
import { AIDEN_MINT } from "@/lib/coin"
import type { Callout } from "@/engine/types"

const walletA = "GC9gKkJjieLPTqDRtm3u6KzL7mhVvMdM4DfMa7aV44ke"
const walletB = "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"

const kv = new Map<string, unknown>()

vi.mock("@/engine/watch-kv", () => ({
  kvEnabled: () => true,
  watchKey: (mint: string) => `callout:watch:${mint}`,
  loadWatch: async (mint: string) => {
    const row = kv.get(`callout:watch:${mint}`)
    return (row as never) ?? null
  },
  saveWatch: async (watch: { mint: string }) => {
    kv.set(`callout:watch:${watch.mint}`, watch)
  },
  deleteWatch: async (mint: string | null | undefined) => {
    if (mint) kv.delete(`callout:watch:${mint}`)
  },
  resetWatchKvForTests: () => kv.clear(),
}))

function callout(
  partial: Partial<Callout> & Pick<Callout, "id" | "wallet" | "callerUsername" | "capturedAt">,
): Callout {
  return {
    token: "AIDEN",
    source: "pump-fun",
    ...partial,
  }
}

describe("durable watch store", () => {
  beforeEach(() => {
    process.env.CALLOUT_PERSIST_TEST = "true"
    kv.clear()
    delete process.env.CALLOUT_MINT
  })

  afterEach(async () => {
    await clearPersistedWatch(AIDEN_MINT)
    delete process.env.CALLOUT_PERSIST_TEST
    kv.clear()
  })

  it("keeps lifetime callers after dropAtOrBefore so bonding can reach min=2 across windows", () => {
    const collector = new CalloutCollector()
    const store = new EngineStore(() => collector.all(), () => [], {
      ...DEFAULT_CONFIG,
      coinMint: AIDEN_MINT,
      distributionToken: "AIDEN",
      migrationMinCallouts: 2,
    })

    const first = collector.ingest({
      id: "w1",
      token: "AIDEN",
      callerUsername: "alpha",
      wallet: walletA,
      capturedAt: "2026-09-20T10:00:00.000Z",
      source: "pump-fun",
    })
    store.rememberLifetimeCallout(first)
    collector.dropAtOrBefore("2026-09-20T10:05:00.000Z")
    expect(collector.all()).toHaveLength(0)
    expect(store.listLifetimeCallouts()).toHaveLength(1)

    const second = collector.ingest({
      id: "w2",
      token: "AIDEN",
      callerUsername: "alpha",
      wallet: walletA,
      capturedAt: "2026-09-20T10:10:00.000Z",
      source: "pump-fun",
    })
    store.rememberLifetimeCallout(second)

    const eligible = buildMigrationCandidates(store.listLifetimeCallouts(), 2)
    expect(eligible).toHaveLength(1)
    expect(eligible[0]?.wallet).toBe(walletA)
    expect(eligible[0]?.calloutCount).toBe(2)
  })

  it("migration monitor counts lifetime ledger, not the pruned collector window", async () => {
    const collector = new CalloutCollector()
    const store = new EngineStore(() => collector.all(), () => [], {
      ...DEFAULT_CONFIG,
      coinMint: AIDEN_MINT,
      distributionToken: "AIDEN",
      migrationMinCallouts: 2,
      mockTxDelayMs: 0,
    })
    store.rememberLifetimeCallouts([
      callout({
        id: "old-1",
        wallet: walletA,
        callerUsername: "alpha",
        capturedAt: "2026-09-20T09:00:00.000Z",
      }),
      callout({
        id: "old-2",
        wallet: walletA,
        callerUsername: "alpha",
        capturedAt: "2026-09-20T09:30:00.000Z",
      }),
    ])
    // Collector is empty (post-snapshot prune) — eligibility must still see 2.
    expect(collector.all()).toHaveLength(0)

    const treasury = new MockTreasury(() => store.config, async () => undefined, 1_000_000_000)
    const monitor = new MigrationMonitor(
      store,
      collector,
      treasury,
      { now: () => new Date("2026-09-20T12:00:00.000Z"), sleep: async () => undefined },
      { int: () => 0, bytes: () => Buffer.alloc(32, 1) },
      async () => true,
      async () => new Response(JSON.stringify({ complete: true, symbol: "AIDEN" }), { status: 200 }),
    )

    const audit = await monitor.pollOnce()
    expect(audit?.confirmationStatus).toBe("confirmed")
    expect(store.migrationEligibleCount).toBe(1)
    expect(audit?.winner?.wallet).toBe(walletA)
  })

  it("persists and reloads rounds + lifetime callers from the durable store", async () => {
    const rounds: PersistedRound[] = [
      {
        id: "snap_1",
        at: "2026-09-20T11:00:00.000Z",
        n: 4,
        s: "confirmed",
        a: 2_500_000,
        tok: "AIDEN",
        L: { u: "@alpha", w: walletA, sig: "sig1", st: "confirmed" },
        R: { u: "@beta", w: walletB, sig: "sig2", st: "confirmed" },
      },
      {
        id: "snap_2",
        at: "2026-09-20T11:20:00.000Z",
        n: 5,
        s: "partial_failure",
        a: 2_500_000,
        tok: "AIDEN",
        L: { u: "@alpha", w: walletA, sig: "sig3", st: "confirmed" },
      },
    ]

    await persistWatch({
      mint: AIDEN_MINT,
      ticker: "AIDEN",
      name: "Aiden",
      lastSnapshotAt: "2026-09-20T11:20:00.000Z",
      rounds,
      callouts: [],
      lifetimeCallouts: [
        { i: "c1", u: "@alpha", w: walletA, t: "2026-09-20T10:00:00.000Z" },
        { i: "c2", u: "@alpha", w: walletA, t: "2026-09-20T10:40:00.000Z" },
        { i: "c3", u: "@beta", w: walletB, t: "2026-09-20T10:50:00.000Z" },
      ],
    })

    expect(kv.has(`callout:watch:${AIDEN_MINT}`)).toBe(true)

    const loaded = await loadPersistedWatch(AIDEN_MINT)
    expect(loaded?.rounds).toHaveLength(2)
    expect(loaded?.lifetimeCallouts).toHaveLength(3)

    const store = new EngineStore(() => [], () => [], {
      ...DEFAULT_CONFIG,
      coinMint: AIDEN_MINT,
      distributionToken: "AIDEN",
    })
    store.hydrateLedger(loaded!.lastSnapshotAt ?? null, loaded!.rounds ?? [])
    expect(store.listAudits()).toHaveLength(2)
    expect(store.lastSnapshotAt).toBe("2026-09-20T11:20:00.000Z")
  })

  it("wipe deletes the durable key so hydrate cannot resurrect history", async () => {
    await persistWatch({
      mint: AIDEN_MINT,
      ticker: "AIDEN",
      name: "Aiden",
      rounds: [
        {
          id: "snap_x",
          at: "2026-09-20T11:00:00.000Z",
          n: 1,
          s: "confirmed",
          a: 1,
          tok: "AIDEN",
        },
      ],
      lifetimeCallouts: [{ i: "c1", u: "@alpha", w: walletA, t: "2026-09-20T10:00:00.000Z" }],
    })
    expect(kv.has(`callout:watch:${AIDEN_MINT}`)).toBe(true)

    await clearPersistedWatch(AIDEN_MINT)
    expect(kv.has(`callout:watch:${AIDEN_MINT}`)).toBe(false)
    expect(await loadPersistedWatch(AIDEN_MINT)).toBeNull()
  })

  it("keeps up to 50 compact rounds when sanitizing", () => {
    const rounds: PersistedRound[] = Array.from({ length: 60 }, (_, i) => ({
      id: `snap_${i}`,
      at: new Date(Date.parse("2026-09-20T10:00:00.000Z") + i * 60_000).toISOString(),
      n: 1,
      s: "confirmed" as const,
      a: 1,
      tok: "AIDEN",
    }))
    expect(auditsFromRounds(rounds)).toHaveLength(50)
  })
})
