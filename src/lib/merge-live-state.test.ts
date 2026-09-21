import { describe, expect, it } from "vitest"
import { mergeClientState, mergeLogs, mergePublicView } from "@/lib/merge-live-state"
import type { ClientState, EngineLog } from "@/engine/types"
import type { PublicView } from "@/lib/public-view"

function view(partial: Partial<PublicView["engine"]> & { callouts?: PublicView["windowCallouts"] }): PublicView {
  return {
    engine: {
      live: true,
      paused: false,
      phase: "idle",
      snapshotInProgress: false,
      startedAt: "2026-09-20T13:00:00.000Z",
      lastSnapshotAt: "2026-09-20T13:49:16.749Z",
      nextSnapshotRangeLabel: "5–15 minutes",
      calloutsInWindow: partial.callouts?.length ?? 0,
      lastPayoutAt: null,
      ...partial,
    },
    mint: {
      address: "mint",
      addressShort: "mint",
      explorerUrl: null,
      ticker: "BELUGA",
      name: "Beluga",
    },
    treasury: {
      address: "t",
      addressShort: "t",
      explorerUrl: null,
      balance: 0,
      balanceLabel: "0",
    },
    allocation: {
      amount: 1,
      amountLabel: "1",
      distributionToken: "BELUGA",
      supplyPercent: 0,
      supplyPercentLabel: "0%",
    },
    totals: {
      payouts: 0,
      wallets: 0,
      tokenAmount: 0,
      tokenLabel: "0",
      supplyPercent: 0,
      supplyPercentLabel: "0%",
      solAmount: 0,
      solLabel: "0",
      snapshots: 0,
      roundsSettled: 0,
      callouts: 0,
    },
    bonding: {
      watchStartedAt: null,
      bonded: true,
      paid: true,
      eligibleCount: 0,
      progressPercent: 100,
      solRaised: 85,
      solTarget: 85,
      bonusAmount: 0,
      bonusAmountLabel: "0",
      bonusSupplyPercentLabel: "0%",
      minCallouts: 2,
    },
    sources: {
      pumpFun: { enabled: true, connected: true },
      axiom: { enabled: false, connected: false },
    },
    telegram: { connected: true, publicUrl: null },
    social: { xUrl: null },
    windowCallouts: partial.callouts ?? [],
    rounds: [],
    migrations: [],
    messages: [],
    activeRound: null,
  }
}

describe("mergePublicView", () => {
  it("keeps prior window callouts when a later poll returns none", () => {
    const prev = view({
      callouts: [
        {
          id: "a",
          username: "@alpha",
          wallet: "A",
          walletShort: "A",
          walletUrl: "",
          token: "$BELUGA",
          capturedAt: "2026-09-20T13:50:00.000Z",
          source: "pump.fun",
        },
      ],
    })
    const next = view({ callouts: [] })
    const merged = mergePublicView(prev, next)
    expect(merged.windowCallouts).toHaveLength(1)
    expect(merged.engine.calloutsInWindow).toBe(1)
  })

  it("does not rewind to an older isolate snapshot", () => {
    const prev = view({
      lastSnapshotAt: "2026-09-20T14:14:56.254Z",
      callouts: [
        {
          id: "b",
          username: "@beta",
          wallet: "B",
          walletShort: "B",
          walletUrl: "",
          token: "$BELUGA",
          capturedAt: "2026-09-20T14:20:00.000Z",
          source: "pump.fun",
        },
      ],
    })
    const next = view({
      lastSnapshotAt: "2026-09-20T13:49:16.749Z",
      callouts: [
        {
          id: "a",
          username: "@alpha",
          wallet: "A",
          walletShort: "A",
          walletUrl: "",
          token: "$BELUGA",
          capturedAt: "2026-09-20T13:50:00.000Z",
          source: "pump.fun",
        },
      ],
    })
    const merged = mergePublicView(prev, next)
    expect(merged.engine.lastSnapshotAt).toBe("2026-09-20T14:14:56.254Z")
    expect(merged.windowCallouts.map((row) => row.id)).toEqual(["b"])
  })

  it("keeps settled rounds when a newer poll is missing them", () => {
    const prev = view({ lastSnapshotAt: "2026-09-20T14:14:56.254Z" })
    prev.rounds = [
      {
        id: "snap_1",
        number: 1,
        timestamp: "2026-09-20T14:14:56.254Z",
        calloutCount: 17,
        status: "confirmed",
        skipReason: null,
        allocationAmount: 2_500_000,
        distributionToken: "BELUGA",
        payoutLabel: "2,500,000 BELUGA",
        lastCaller: null,
        randomCaller: null,
        transactions: [
          {
            kind: "random_caller",
            username: "@FishInvitedStem",
            wallet: "W",
            walletShort: "W",
            walletUrl: "",
            amount: 2_500_000,
            amountLabel: "2,500,000",
            distributionToken: "BELUGA",
            signature: "sig",
            explorerUrl: null,
            status: "confirmed",
          },
        ],
        explorerLinks: [],
      },
    ]
    const next = view({ lastSnapshotAt: "2026-09-20T14:14:56.254Z", callouts: [] })
    expect(mergePublicView(prev, next).rounds).toHaveLength(1)
  })

  it("replaces the list after a new snapshot window", () => {
    const prev = view({
      callouts: [
        {
          id: "a",
          username: "@alpha",
          wallet: "A",
          walletShort: "A",
          walletUrl: "",
          token: "$BELUGA",
          capturedAt: "2026-09-20T13:50:00.000Z",
          source: "pump.fun",
        },
      ],
    })
    const next = view({
      lastSnapshotAt: "2026-09-20T14:00:00.000Z",
      callouts: [],
    })
    expect(mergePublicView(prev, next).windowCallouts).toHaveLength(0)
  })

  it("drops the previous window when the watched mint changes", () => {
    const prev = view({
      callouts: [
        {
          id: "a",
          username: "@alpha",
          wallet: "A",
          walletShort: "A",
          walletUrl: "",
          token: "$TEST",
          capturedAt: "2026-09-20T13:50:00.000Z",
          source: "pump.fun",
        },
      ],
    })
    const next = view({ callouts: [] })
    next.mint = { ...next.mint, address: null, addressShort: null, ticker: "SHILL", name: null }
    const merged = mergePublicView(prev, next)
    expect(merged.windowCallouts).toHaveLength(0)
    expect(merged.mint.address).toBeNull()
  })
})

function logLine(partial: Partial<EngineLog> & Pick<EngineLog, "message" | "at">): EngineLog {
  return {
    id: partial.id ?? `log-${partial.at}`,
    level: partial.level ?? "info",
    at: partial.at,
    message: partial.message,
  }
}

function client(logs: EngineLog[], lastSnapshotAt: string | null = null): ClientState {
  return {
    status: {
      lastSnapshotAt,
      startedAt: "2026-09-20T13:00:00.000Z",
      calloutsInWindow: 0,
    } as ClientState["status"],
    messages: [],
    callouts: [],
    audits: [],
    migrations: [],
    logs,
  }
}

describe("mergeClientState logs", () => {
  it("keeps console lines from both isolates instead of replacing the list", () => {
    const prev = client([
      logLine({ id: "log-1", at: "2026-09-20T15:41:00.000Z", message: "New cycle — QUALIFIED board cleared" }),
    ])
    const next = client([
      logLine({
        id: "log-1",
        at: "2026-09-20T15:39:00.000Z",
        message: "[wallet] Pin mint 3FZKytE87Psjb2jt8wzN53YjyiNLwUPruff2gxt1pump ≠",
      }),
    ])
    const merged = mergeClientState(prev, next)
    expect(merged.logs.map((row) => row.message)).toEqual([
      "New cycle — QUALIFIED board cleared",
      "[wallet] Pin mint 3FZKytE87Psjb2jt8wzN53YjyiNLwUPruff2gxt1pump ≠",
    ])
  })

  it("does not duplicate the same line when ids differ across isolates", () => {
    const line = logLine({
      id: "log-4",
      at: "2026-09-20T15:41:00.000Z",
      message: "New cycle — QUALIFIED board cleared",
    })
    const merged = mergeLogs([{ ...line, id: "log-1" }], [{ ...line, id: "log-9" }])
    expect(merged).toHaveLength(1)
  })

  it("keeps one boot line and the newest next-snapshot deadline", () => {
    const merged = mergeLogs(
      [
        logLine({
          at: "2026-09-20T15:48:00.000Z",
          message: "Watching Pump.fun callouts for 7hD7rBygiLY22G9MGj2qUGAET39Nx5F5AZVjEdbxpump",
        }),
        logLine({
          at: "2026-09-20T15:48:01.000Z",
          message: "[wallet] Next snapshot in 7m 49s → 2026-09-20T15:56:25.678Z | mint=7hD7rBygiLY22G9MGj2qUGAET39Nx5F5AZVjEdbxpump",
        }),
      ],
      [
        logLine({
          at: "2026-09-20T15:48:10.000Z",
          message: "Watching Pump.fun callouts for 7hD7rBygiLY22G9MGj2qUGAET39Nx5F5AZVjEdbxpump",
        }),
        logLine({
          at: "2026-09-20T15:48:11.000Z",
          message: "[wallet] Next snapshot in 12m 05s → 2026-09-20T16:00:44.110Z | mint=7hD7rBygiLY22G9MGj2qUGAET39Nx5F5AZVjEdbxpump",
        }),
      ],
    )
    expect(merged).toHaveLength(2)
    expect(merged[0].message).toContain("12m 05s")
    expect(merged.filter((row) => row.message.startsWith("Watching"))).toHaveLength(1)
  })
})
