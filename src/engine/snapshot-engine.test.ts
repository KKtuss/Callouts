import { describe, expect, it } from "vitest"
import { CalloutCollector, DuplicateCalloutError } from "@/engine/collector"
import { SnapshotEngine, type Clock } from "@/engine/snapshot-engine"
import { DEFAULT_CONFIG, EngineStore } from "@/engine/store"
import { MockTreasury } from "@/engine/treasury"
import type { Callout } from "@/engine/types"
import { PreviewBroadcast, type Broadcast } from "@/telegram/broadcast"
import type { FormattedMessage } from "@/telegram/messages"
import type { SecureRandom } from "@/lib/crypto-random"

class ScriptedRandom implements SecureRandom {
  constructor(private ints: number[]) {}
  int(maxExclusive: number): number {
    const next = this.ints.shift()
    if (next === undefined) return 0
    if (next >= maxExclusive) return 0
    return next
  }
  bytes(size: number): Buffer {
    return Buffer.alloc(size, 3)
  }
}

class RecordingBroadcast implements Broadcast {
  readonly sequence: Array<{ op: "send" | "edit"; kind: string; text: string }> = []
  private readonly inner = new PreviewBroadcast()

  getMessages() {
    return this.inner.getMessages()
  }

  async send(message: FormattedMessage) {
    this.sequence.push({ op: "send", kind: message.kind, text: message.text })
    return this.inner.send(message)
  }

  async edit(id: string, message: FormattedMessage) {
    this.sequence.push({ op: "edit", kind: message.kind, text: message.text })
    return this.inner.edit(id, message)
  }

  async disablePublicCommands() {
    await this.inner.disablePublicCommands()
  }
}

function clock(): Clock {
  let t = Date.parse("2026-09-19T17:13:00.000Z")
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

function seed(collector: CalloutCollector) {
  const rows: Callout[] = [
    {
      id: "a",
      token: "$BONK",
      callerUsername: "@caller_a",
      wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      capturedAt: "2026-09-19T17:02:00.000Z",
      source: "demo-feed",
    },
    {
      id: "b",
      token: "$BONK",
      callerUsername: "@caller_b",
      wallet: "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      capturedAt: "2026-09-19T17:08:00.000Z",
      source: "demo-feed",
    },
    {
      id: "c",
      token: "$BONK",
      callerUsername: "@caller_c",
      wallet: "9zKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      capturedAt: "2026-09-19T17:11:00.000Z",
      source: "demo-feed",
    },
    {
      id: "d",
      token: "$BONK",
      callerUsername: "@caller_d",
      wallet: "4LmXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      capturedAt: "2026-09-19T17:12:30.000Z",
      source: "demo-feed",
    },
  ]
  for (const row of rows) collector.ingest(row)
}

describe("SnapshotEngine broadcast lifecycle", () => {
  it("commits CSPRNG selection before the roulette animation and keeps Telegram command-free", async () => {
    const collector = new CalloutCollector()
    seed(collector)
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      {
        ...DEFAULT_CONFIG,
        startupSnapshotDelayMs: null,
        rouletteFrameCount: 4,
        rouletteFrameMs: 10,
        mockTxDelayMs: 5,
        feederEnabled: false,
      },
      "2026-09-19T17:00:00.000Z",
    )
    const time = clock()
    const treasury = new MockTreasury(() => store.config, time.sleep, 10_000)
    const engine = new SnapshotEngine(
      store,
      collector,
      treasury,
      broadcast,
      time,
      new ScriptedRandom([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    )

    const audit = await engine.runSnapshot("admin")
    expect(audit).not.toBeNull()
    if (!audit) throw new Error("expected audit")

    expect(audit.selectionMethod).toBe("node:crypto.randomInt")
    expect(audit.selectionEntropyHex).toHaveLength(64)
    expect(audit.lastCallout.token).toBe("$BONK")
    expect(audit.lastCallout.callerUsername).toBe("@caller_d")
    expect(audit.rouletteWinner.id).not.toBe(audit.lastCallout.id)
    expect(new Date(audit.selectionCommittedAt).getTime()).toBeLessThanOrEqual(
      new Date(audit.animationStartedAt!).getTime(),
    )

    const kinds = broadcast.sequence.map((item) => `${item.op}:${item.kind}`)
    expect(kinds[0]).toBe("send:snapshot")
    expect(broadcast.sequence[0].text).toContain("Taking snapshot")
    expect(kinds[1]).toBe("edit:snapshot")
    expect(broadcast.sequence[1].text).toContain("Callouts captured: 4")
    expect(kinds[2]).toBe("send:roulette")
    expect(broadcast.sequence[2].text).toContain("Selecting a callout")
    expect(kinds.some((kind) => kind === "edit:roulette")).toBe(true)

    const selected = broadcast.sequence.find((item) => item.text.includes("SELECTED"))
    expect(selected?.text).toContain(audit.rouletteWinner.callerUsername)
    expect(selected?.text).toContain("$BONK")

    const final = broadcast.sequence.find((item) => item.kind === "final")
    expect(final?.text).toContain("Last Callout")
    expect(final?.text).toContain("Roulette Winner")
    expect(final?.text).toContain("Randomized between")
    expect(final?.text).toMatch(/TX:/)

    expect(audit.calloutCount).toBe(4)
    expect(audit.rouletteCandidatePool.length).toBeGreaterThan(0)
    expect(audit.transactions).toHaveLength(2)
    expect(audit.transactions.every((tx) => tx.status === "confirmed")).toBe(true)
    expect(audit.transactions.every((tx) => Boolean(tx.signature))).toBe(true)
    expect(audit.confirmationStatus).toBe("confirmed")
    expect(JSON.stringify(audit)).not.toMatch(/private key|secretKey|PRIVATE/i)

    const publicText = broadcast.sequence.map((item) => item.text).join("\n")
    expect(publicText).not.toMatch(/\/status|\/pause|\/admin|\/snapshot/)
    expect(store.status().telegramConnected).toBe(false)
  })

  it("does not broadcast when the window has no callouts", async () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      { ...DEFAULT_CONFIG, startupSnapshotDelayMs: null, mockTxDelayMs: 0 },
      "2026-09-19T17:00:00.000Z",
    )
    const engine = new SnapshotEngine(
      store,
      collector,
      new MockTreasury(() => store.config, async () => undefined),
      broadcast,
      clock(),
      new ScriptedRandom([]),
    )

    const audit = await engine.runSnapshot("scheduler")
    expect(audit?.confirmationStatus).toBe("skipped")
    expect(broadcast.sequence).toHaveLength(0)
  })

  it("rejects callouts for any coin other than the configured token", async () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      { ...DEFAULT_CONFIG, startupSnapshotDelayMs: null, feederEnabled: false },
      "2026-09-19T17:00:00.000Z",
    )
    const engine = new SnapshotEngine(
      store,
      collector,
      new MockTreasury(() => store.config, async () => undefined),
      broadcast,
      clock(),
      new ScriptedRandom([]),
    )

    expect(() =>
      engine.ingestCallout({
        token: "$WIF",
        callerUsername: "alpha",
        wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        source: "private-ingest",
      }),
    ).toThrow(/only \$BONK/i)

    const accepted = engine.ingestCallout({
      callerUsername: "alpha",
      wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      source: "private-ingest",
    })
    expect(accepted.token).toBe("$BONK")
  })

  it("ignores other-coin callouts already sitting in the collector", async () => {
    const collector = new CalloutCollector()
    collector.ingest({
      id: "foreign",
      token: "$WIF",
      callerUsername: "@intruder",
      wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      capturedAt: "2026-09-19T17:02:00.000Z",
      source: "demo-feed",
    })
    collector.ingest({
      id: "home",
      token: "$BONK",
      callerUsername: "@keeper",
      wallet: "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      capturedAt: "2026-09-19T17:03:00.000Z",
      source: "demo-feed",
    })
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      {
        ...DEFAULT_CONFIG,
        startupSnapshotDelayMs: null,
        rouletteFrameCount: 2,
        rouletteFrameMs: 1,
        mockTxDelayMs: 0,
        feederEnabled: false,
      },
      "2026-09-19T17:00:00.000Z",
    )
    const engine = new SnapshotEngine(
      store,
      collector,
      new MockTreasury(() => store.config, async () => undefined),
      broadcast,
      clock(),
      new ScriptedRandom([0, 0, 0, 0]),
    )

    const audit = await engine.runSnapshot("admin")
    expect(audit?.calloutCount).toBe(1)
    expect(audit?.lastCallout.id).toBe("home")
    expect(audit?.lastCallout.token).toBe("$BONK")
  })

  it("accepts the configured mint address as the same coin", async () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      {
        ...DEFAULT_CONFIG,
        distributionToken: "AIDEN",
        coinMint: "4i5FqkfYDAPcEVcXyuVyaaBcz3bpwJPqDkmaF36kpump",
        coinName: "The Day Trader",
        startupSnapshotDelayMs: null,
        feederEnabled: false,
      },
      "2026-09-19T17:00:00.000Z",
    )
    const engine = new SnapshotEngine(
      store,
      collector,
      new MockTreasury(() => store.config, async () => undefined),
      broadcast,
      clock(),
      new ScriptedRandom([]),
    )

    const accepted = engine.ingestCallout({
      token: "4i5FqkfYDAPcEVcXyuVyaaBcz3bpwJPqDkmaF36kpump",
      callerUsername: "alpha",
      wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      source: "private-ingest",
    })
    expect(accepted.token).toBe("$AIDEN")
    expect(() =>
      engine.ingestCallout({
        token: "$BONK",
        callerUsername: "alpha",
        wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        source: "private-ingest",
      }),
    ).toThrow(/only \$AIDEN/i)
  })

  it("stores one callout per caller then pays last plus a random unique caller", async () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      {
        ...DEFAULT_CONFIG,
        distributionToken: "AIDEN",
        coinMint: "4i5FqkfYDAPcEVcXyuVyaaBcz3bpwJPqDkmaF36kpump",
        startupSnapshotDelayMs: null,
        rouletteFrameCount: 2,
        rouletteFrameMs: 1,
        mockTxDelayMs: 0,
        feederEnabled: false,
      },
      "2026-09-19T17:00:00.000Z",
    )
    const engine = new SnapshotEngine(
      store,
      collector,
      new MockTreasury(() => store.config, async () => undefined),
      broadcast,
      clock(),
      new ScriptedRandom([0, 0, 0, 0]),
    )
    const wallets = [
      "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      "9zKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    ]

    engine.ingestCallout({
      callerUsername: "alpha",
      wallet: wallets[0],
      source: "pump-fun",
      capturedAt: "2026-09-19T17:01:00.000Z",
    })
    expect(() =>
      engine.ingestCallout({
        callerUsername: "alpha",
        wallet: wallets[0],
        source: "pump-fun",
        capturedAt: "2026-09-19T17:02:00.000Z",
      }),
    ).toThrow(DuplicateCalloutError)
    engine.ingestCallout({
      callerUsername: "beta",
      wallet: wallets[1],
      source: "pump-fun",
      capturedAt: "2026-09-19T17:08:00.000Z",
    })
    engine.ingestCallout({
      callerUsername: "gamma",
      wallet: wallets[2],
      source: "pump-fun",
      capturedAt: "2026-09-19T17:12:00.000Z",
    })

    const audit = await engine.runSnapshot("admin")
    expect(audit?.calloutCount).toBe(3)
    expect(audit?.lastCallout.callerUsername).toBe("@gamma")
    expect(audit?.rouletteWinner.callerUsername).toBe("@alpha")
    expect(audit?.transactions).toHaveLength(2)
    expect(audit?.transactions.map((tx) => tx.kind)).toEqual(["last_callout", "roulette"])
    expect(audit?.transactions.every((tx) => tx.status === "confirmed")).toBe(true)
  })

  it("notifies the channel for each new unique caller in the current snapshot window", () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      { ...DEFAULT_CONFIG, startupSnapshotDelayMs: null, feederEnabled: false },
      "2026-09-19T17:00:00.000Z",
    )
    const engine = new SnapshotEngine(
      store,
      collector,
      new MockTreasury(() => store.config, async () => undefined),
      broadcast,
      clock(),
      new ScriptedRandom([]),
    )
    const walletA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    const walletB = "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"

    engine.ingestCallout({
      callerUsername: "alpha",
      wallet: walletA,
      source: "private-ingest",
      capturedAt: "2026-09-19T17:01:00.000Z",
    })
    expect(() =>
      engine.ingestCallout({
        callerUsername: "alpha",
        wallet: walletA,
        source: "private-ingest",
        capturedAt: "2026-09-19T17:02:00.000Z",
      }),
    ).toThrow(DuplicateCalloutError)
    engine.ingestCallout({
      callerUsername: "beta",
      wallet: walletB,
      source: "private-ingest",
      capturedAt: "2026-09-19T16:50:00.000Z",
    })

    const qualified = broadcast.sequence.filter((item) => item.kind === "qualified")
    expect(qualified).toHaveLength(1)
    expect(qualified[0].text).toContain("@alpha")
    expect(qualified[0].text).toContain("Eligible this snapshot: 1")
  })
})
