import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { CalloutCollector, DuplicateCalloutError } from "@/engine/collector"
import { SnapshotEngine, type Clock } from "@/engine/snapshot-engine"
import { DEFAULT_CONFIG, EngineStore } from "@/engine/store"
import { MockTreasury } from "@/engine/treasury"
import type { Callout } from "@/engine/types"
import { PreviewBroadcast, type Broadcast } from "@/telegram/broadcast"
import type { FormattedMessage } from "@/telegram/messages"
import type { SecureRandom } from "@/lib/crypto-random"
import * as persistWatch from "@/engine/persist-watch"
import type { PinBoardRef } from "@/engine/persist-watch"

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
  readonly sequence: Array<{ op: "send" | "edit" | "delete"; kind: string; text: string }> = []
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

  async delete(id: string) {
    const numeric = Number(id)
    const current = this.inner.getMessages().find(
      (item) =>
        item.id === id || (Number.isFinite(numeric) && item.telegramMessageId === numeric),
    )
    this.sequence.push({
      op: "delete",
      kind: current?.kind ?? "unknown",
      text: current?.text ?? "",
    })
    await this.inner.delete(id)
  }

  async clear(options?: { purgeTelegram?: number }) {
    this.sequence.push({
      op: "delete",
      kind: "clear",
      text: `purge=${options?.purgeTelegram ?? 0}`,
    })
    await this.inner.clear(options)
  }

  async ensureIntro(
    _payload: Parameters<Broadcast["ensureIntro"]>[0],
    message: FormattedMessage,
    options?: Parameters<Broadcast["ensureIntro"]>[2],
  ) {
    this.sequence.push({ op: "send", kind: message.kind, text: message.text })
    return this.inner.ensureIntro(_payload, message, options)
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
    expect(selected?.text).not.toContain("$BONK")

    expect(kinds).toContain("delete:snapshot")
    expect(kinds).toContain("delete:roulette")
    expect(broadcast.getMessages().some((item) => item.kind === "snapshot")).toBe(false)
    expect(broadcast.getMessages().some((item) => item.kind === "roulette")).toBe(false)
    expect(broadcast.getMessages().some((item) => item.kind === "final")).toBe(true)

    const final = broadcast.sequence.filter((item) => item.kind === "final")
    expect(final.some((item) => item.op === "send")).toBe(true)
    const complete = final.find((item) => item.text.includes("Randomized between"))
    expect(complete?.text).toContain("SNAPSHOT #1")
    expect(complete?.text).not.toContain("PAYOUT")
    expect(complete?.text).toContain("Last callout")
    expect(complete?.text).toContain("Roulette winner")
    expect(complete?.text).toMatch(/TX:/)
    expect(broadcast.sequence.filter((item) => item.kind === "recipients")).toHaveLength(0)
    expect(broadcast.sequence.filter((item) => item.kind === "distribution")).toHaveLength(0)

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

  it("delete-reposts one QUALIFIED board as the eligible list grows", async () => {
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
      thesis: "first in",
    })
    await engine.flushQualifiedNotices()

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
      capturedAt: "2026-09-19T17:03:00.000Z",
      thesis: "sending it",
    })
    await engine.flushQualifiedNotices()

    const qualified = broadcast.sequence.filter((item) => item.kind === "qualified")
    expect(qualified.filter((item) => item.op === "send")).toHaveLength(1)
    expect(qualified.filter((item) => item.op === "edit")).toHaveLength(1)
    expect(qualified.filter((item) => item.op === "delete")).toHaveLength(0)
    expect(qualified[0].text).toContain("🗣️")
    expect(qualified[0].text).toContain("@alpha")
    expect(qualified[0].text).toContain("first in")
    expect(qualified[0].text).toContain("Eligible this snapshot: 1")
    const latest = qualified.filter((item) => item.op === "edit").at(-1)
    expect(latest?.text).toContain("@beta")
    expect(latest?.text).toContain("sending it")
    expect(latest?.text).toContain("@alpha")
    expect(latest?.text).toContain("Eligible this snapshot: 2")
    expect(broadcast.getMessages().filter((item) => item.kind === "qualified")).toHaveLength(1)
  })

  it("does not delete QUALIFIED when this isolate has no window callouts yet", async () => {
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
    engine.ingestCallout({
      callerUsername: "alpha",
      wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      source: "private-ingest",
      capturedAt: "2026-09-19T17:01:00.000Z",
    })
    await engine.flushQualifiedNotices()
    expect(broadcast.getMessages().filter((item) => item.kind === "qualified")).toHaveLength(1)

    collector.clear()
    await engine.syncQualifiedBoard()
    expect(broadcast.sequence.filter((item) => item.op === "delete" && item.kind === "qualified")).toHaveLength(0)
    expect(broadcast.getMessages().filter((item) => item.kind === "qualified")).toHaveLength(1)
  })

  it("deletes the restored Telegram QUALIFIED id even without a local preview id", async () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      { ...DEFAULT_CONFIG, startupSnapshotDelayMs: null, feederEnabled: false },
      "2026-09-19T17:00:00.000Z",
    )
    const originalSend = broadcast.send.bind(broadcast)
    let telegramId = 700
    broadcast.send = async (message) => {
      const sent = await originalSend(message)
      telegramId += 1
      return { ...sent, telegramMessageId: telegramId }
    }

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
    await engine.flushQualifiedNotices()

    engine.ingestCallout({
      callerUsername: "beta",
      wallet: walletB,
      source: "private-ingest",
      capturedAt: "2026-09-19T17:03:00.000Z",
    })
    await engine.flushQualifiedNotices()

    expect(broadcast.getMessages().filter((item) => item.kind === "qualified")).toHaveLength(1)
  })

  it("publishes QUALIFIED once after a silent backfill sync", async () => {
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
    engine.ingestCallout({
      callerUsername: "alpha",
      wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      source: "private-ingest",
      capturedAt: "2026-09-19T17:01:00.000Z",
      silent: true,
    })
    await engine.flushQualifiedNotices()
    expect(broadcast.sequence.filter((item) => item.kind === "qualified")).toHaveLength(0)
    await engine.syncQualifiedBoard()
    const qualified = broadcast.sequence.filter((item) => item.kind === "qualified")
    expect(qualified.filter((item) => item.op === "send")).toHaveLength(1)
    expect(qualified[0].text).toContain("@alpha")
    expect(qualified[0].text).toContain("Eligible this snapshot: 1")
  })

  it("does not post QUALIFIED when the pin already has this board", async () => {
    const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    const fingerprint = `alpha:${wallet}#`
    const hash = createHash("sha1").update(fingerprint).digest("hex").slice(0, 16)
    const prevToken = process.env.TELEGRAM_BOT_TOKEN
    const prevChat = process.env.TELEGRAM_CHANNEL_ID
    process.env.TELEGRAM_BOT_TOKEN = "test-token"
    process.env.TELEGRAM_CHANNEL_ID = "-1001"
    const spy = vi.spyOn(persistWatch, "readQualifiedBoardFromPin").mockResolvedValue({
      qualifiedTelegramId: 801,
      qualifiedTelegramIds: [801],
      qualifiedFingerprintHash: hash,
      qualifiedCount: 1,
      lastSnapshotAt: null,
      nextSnapshotAt: null,
      snapshotClaimId: null,
      schedulerPaused: null,
      rounds: [],
      migrationPaid: null,
      callouts: [],
    } satisfies PinBoardRef)
    try {
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
      engine.ingestCallout({
        callerUsername: "alpha",
        wallet,
        source: "private-ingest",
        capturedAt: "2026-09-19T17:01:00.000Z",
        id: "co_alpha",
      })
      await engine.flushQualifiedNotices()
      expect(broadcast.sequence.filter((item) => item.kind === "qualified" && item.op === "send")).toHaveLength(
        0,
      )
    } finally {
      spy.mockRestore()
      if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
      else process.env.TELEGRAM_BOT_TOKEN = prevToken
      if (prevChat === undefined) delete process.env.TELEGRAM_CHANNEL_ID
      else process.env.TELEGRAM_CHANNEL_ID = prevChat
    }
  })

  it("deletes this isolate's QUALIFIED post when the pin already recorded another", async () => {
    const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    const fingerprint = `alpha:${wallet}#`
    const hash = createHash("sha1").update(fingerprint).digest("hex").slice(0, 16)
    const emptyPin: PinBoardRef = {
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
    }
    const prevToken = process.env.TELEGRAM_BOT_TOKEN
    const prevChat = process.env.TELEGRAM_CHANNEL_ID
    process.env.TELEGRAM_BOT_TOKEN = "test-token"
    process.env.TELEGRAM_CHANNEL_ID = "-1001"
    let posted = false
    const spy = vi.spyOn(persistWatch, "readQualifiedBoardFromPin").mockImplementation(async () => {
      if (!posted) return emptyPin
      return {
        ...emptyPin,
        qualifiedTelegramId: 999,
        qualifiedTelegramIds: [999],
        qualifiedFingerprintHash: hash,
        qualifiedCount: 1,
      }
    })
    try {
      const collector = new CalloutCollector()
      const broadcast = new RecordingBroadcast()
      const originalSend = broadcast.send.bind(broadcast)
      const originalDelete = broadcast.delete.bind(broadcast)
      const deletedIds: string[] = []
      broadcast.send = async (message) => {
        const sent = await originalSend(message)
        if (message.kind === "qualified") posted = true
        return { ...sent, telegramMessageId: 701 }
      }
      broadcast.delete = async (id) => {
        deletedIds.push(id)
        await originalDelete(id)
      }
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
      engine.ingestCallout({
        callerUsername: "alpha",
        wallet,
        source: "private-ingest",
        capturedAt: "2026-09-19T17:01:00.000Z",
        id: "co_alpha",
      })
      await engine.flushQualifiedNotices()
      expect(broadcast.sequence.filter((item) => item.kind === "qualified" && item.op === "send")).toHaveLength(
        1,
      )
      expect(deletedIds).toContain("701")
    } finally {
      spy.mockRestore()
      if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
      else process.env.TELEGRAM_BOT_TOKEN = prevToken
      if (prevChat === undefined) delete process.env.TELEGRAM_CHANNEL_ID
      else process.env.TELEGRAM_CHANNEL_ID = prevChat
    }
  })

  it("does not publish a channel intro on start or when mint is unset", async () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      {
        ...DEFAULT_CONFIG,
        coinMint: null,
        feederEnabled: false,
        startupSnapshotDelayMs: 60_000,
      },
      "2026-09-19T17:00:00.000Z",
    )
    const time = clock()
    const treasury = new MockTreasury(() => store.config, time.sleep, 10_000)
    const engine = new SnapshotEngine(store, collector, treasury, broadcast, time)
    engine.start()
    await engine.publishChannelIntro(false)
    expect(broadcast.sequence.filter((item) => item.kind === "intro")).toHaveLength(0)
    engine.stop()
  })

  it("publishes a waiting intro when mint is unset and createIfMissing is set", async () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      {
        ...DEFAULT_CONFIG,
        coinMint: null,
        feederEnabled: false,
        startupSnapshotDelayMs: 60_000,
      },
      "2026-09-19T17:00:00.000Z",
    )
    const time = clock()
    const treasury = new MockTreasury(() => store.config, time.sleep, 10_000)
    const engine = new SnapshotEngine(store, collector, treasury, broadcast, time)
    await engine.publishChannelIntro(true)
    const intro = broadcast.sequence.filter((item) => item.kind === "intro")
    expect(intro).toHaveLength(1)
    expect(intro[0]?.text).toContain("Waiting for SHILL tech to be live...")
    expect(intro[0]?.text).not.toContain("Mint:")
    engine.stop()
  })

  it("launches from idle without purging Telegram history", async () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      {
        ...DEFAULT_CONFIG,
        coinMint: null,
        feederEnabled: false,
        pumpIngestEnabled: false,
      },
      "2026-09-19T17:00:00.000Z",
    )
    const time = clock()
    const treasury = new MockTreasury(() => store.config, time.sleep, 10_000)
    const engine = new SnapshotEngine(store, collector, treasury, broadcast, time)
    await engine.publishChannelIntro(true)
    store.config = {
      ...store.config,
      coinMint: "BKfdpRHgMUnZiLzBQjts6XimqrRedZVvxEjFttsHpump",
      distributionToken: "TEST",
      coinName: "TEST",
    }
    await engine.launchFromIdle()
    expect(broadcast.sequence.some((item) => item.text.startsWith("purge="))).toBe(false)
    const intros = broadcast.sequence.filter((item) => item.kind === "intro")
    expect(intros.at(-1)?.text).toContain("Mint:")
    expect(intros.at(-1)?.text).toContain("BKfd")
    engine.stop()
  })

  it("enters idle and purges Telegram when leaving a live mint", async () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      {
        ...DEFAULT_CONFIG,
        coinMint: "BKfdpRHgMUnZiLzBQjts6XimqrRedZVvxEjFttsHpump",
        distributionToken: "TEST",
        feederEnabled: false,
        pumpIngestEnabled: false,
      },
      "2026-09-19T17:00:00.000Z",
    )
    const time = clock()
    const treasury = new MockTreasury(() => store.config, time.sleep, 10_000)
    const engine = new SnapshotEngine(store, collector, treasury, broadcast, time)
    await engine.enterIdle({ purgeTelegram: true })
    expect(store.config.coinMint).toBeNull()
    expect(store.schedulerPaused).toBe(true)
    expect(broadcast.sequence.some((item) => item.text === "purge=5000")).toBe(true)
    expect(broadcast.sequence.some((item) => item.text.includes("Waiting for SHILL tech to be live..."))).toBe(
      true,
    )
    engine.stop()
  })

  it("pays token allocation after bond when creator rewards are empty", async () => {
    const collector = new CalloutCollector()
    seed(collector)
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
    store.migrationBonded = true
    store.migrationPaid = true
    const time = clock()
    const treasury = new MockTreasury(() => store.config, time.sleep, 10_000)
    const engine = new SnapshotEngine(
      store,
      collector,
      treasury,
      broadcast,
      time,
      new ScriptedRandom([0, 0, 0, 0, 0, 0, 0, 0]),
    )

    const audit = await engine.runSnapshot("admin")
    expect(audit?.confirmationStatus).toBe("confirmed")
    expect(audit?.transactions).toHaveLength(2)
    expect(audit?.transactions.every((tx) => tx.status === "confirmed")).toBe(true)
    expect(audit?.transactions.every((tx) => tx.distributionToken !== "SOL")).toBe(true)
    expect(audit?.transactions.every((tx) => tx.amount > 0)).toBe(true)
    expect(audit?.allocationAmount).toBe(store.config.allocationAmount)
  })

  it("does not restage an overdue pin deadline after that snapshot already landed", async () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(
      () => collector.all(),
      () => broadcast.getMessages(),
      { ...DEFAULT_CONFIG, startupSnapshotDelayMs: null, feederEnabled: false },
      "2026-09-19T17:00:00.000Z",
    )
    store.lastSnapshotAt = "2026-09-19T17:13:00.000Z"
    const engine = new SnapshotEngine(
      store,
      collector,
      new MockTreasury(() => store.config, async () => undefined),
      broadcast,
      clock(),
      new ScriptedRandom([]),
    )
    engine.restoreDeadline("2026-09-19T17:12:50.000Z")
    expect(store.nextSnapshotAt).toBeNull()
    expect(broadcast.sequence).toHaveLength(0)
    const skipped = await engine.runSnapshot("scheduler")
    expect(skipped).toBeNull()
    expect(broadcast.sequence).toHaveLength(0)
    engine.stop()
  })

  it("does not replace a future snapshot deadline with a stale past pin time", () => {
    const store = new EngineStore(
      () => [],
      () => [],
      DEFAULT_CONFIG,
      "2026-09-19T17:00:00.000Z",
    )
    const future = new Date(Date.now() + 12 * 60_000).toISOString()
    const past = new Date(Date.now() - 8 * 60_000).toISOString()
    store.nextSnapshotAt = future
    store.hydrateScheduler(past, null)
    expect(store.nextSnapshotAt).toBe(future)
    store.lastSnapshotAt = new Date().toISOString()
    store.nextSnapshotAt = null
    store.hydrateScheduler(past, null)
    expect(store.nextSnapshotAt).toBeNull()
  })

  it("does not QUALIFIED-publish callers at or before the pin snapshot time", async () => {
    const walletA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    const walletB = "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    const snap = "2026-09-19T17:13:00.000Z"
    const prevToken = process.env.TELEGRAM_BOT_TOKEN
    const prevChat = process.env.TELEGRAM_CHANNEL_ID
    process.env.TELEGRAM_BOT_TOKEN = "test-token"
    process.env.TELEGRAM_CHANNEL_ID = "-1001"
    const spy = vi.spyOn(persistWatch, "readQualifiedBoardFromPin").mockResolvedValue({
      qualifiedTelegramId: 801,
      qualifiedTelegramIds: [801],
      qualifiedFingerprintHash: "stale-board",
      qualifiedCount: 2,
      lastSnapshotAt: snap,
      nextSnapshotAt: null,
      snapshotClaimId: null,
      schedulerPaused: null,
      rounds: [],
      migrationPaid: null,
      callouts: [
        { i: "a", u: "@alpha", w: walletA, t: "2026-09-19T17:01:00.000Z" },
        { i: "b", u: "@beta", w: walletB, t: "2026-09-19T17:03:00.000Z" },
      ],
    } satisfies PinBoardRef)
    try {
      const collector = new CalloutCollector()
      collector.ingest({
        id: "a",
        token: "$BONK",
        callerUsername: "@alpha",
        wallet: walletA,
        capturedAt: "2026-09-19T17:01:00.000Z",
        source: "pump-fun",
      })
      collector.ingest({
        id: "b",
        token: "$BONK",
        callerUsername: "@beta",
        wallet: walletB,
        capturedAt: "2026-09-19T17:03:00.000Z",
        source: "pump-fun",
      })
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
      await engine.syncQualifiedBoard()
      expect(broadcast.sequence.filter((item) => item.kind === "qualified")).toHaveLength(0)
      expect(collector.all()).toHaveLength(0)
    } finally {
      spy.mockRestore()
      if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
      else process.env.TELEGRAM_BOT_TOKEN = prevToken
      if (prevChat === undefined) delete process.env.TELEGRAM_CHANNEL_ID
      else process.env.TELEGRAM_CHANNEL_ID = prevChat
    }
  })

  it("posts QUALIFIED in a new window even if the pin still has the previous qn", async () => {
    const walletA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    const walletB = "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    const walletC = "9zKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    const snap = "2026-09-19T17:13:00.000Z"
    const prevToken = process.env.TELEGRAM_BOT_TOKEN
    const prevChat = process.env.TELEGRAM_CHANNEL_ID
    process.env.TELEGRAM_BOT_TOKEN = "test-token"
    process.env.TELEGRAM_CHANNEL_ID = "-1001"
    const spy = vi.spyOn(persistWatch, "readQualifiedBoardFromPin").mockResolvedValue({
      qualifiedTelegramId: 801,
      qualifiedTelegramIds: [801],
      qualifiedFingerprintHash: "old-two",
      qualifiedCount: 2,
      lastSnapshotAt: snap,
      nextSnapshotAt: null,
      snapshotClaimId: null,
      schedulerPaused: null,
      rounds: [],
      migrationPaid: null,
      callouts: [
        { i: "a", u: "@alpha", w: walletA, t: "2026-09-19T17:01:00.000Z" },
        { i: "b", u: "@beta", w: walletB, t: "2026-09-19T17:03:00.000Z" },
      ],
    } satisfies PinBoardRef)
    try {
      const collector = new CalloutCollector()
      const broadcast = new RecordingBroadcast()
      const store = new EngineStore(
        () => collector.all(),
        () => broadcast.getMessages(),
        { ...DEFAULT_CONFIG, startupSnapshotDelayMs: null, feederEnabled: false },
        "2026-09-19T17:00:00.000Z",
      )
      store.lastSnapshotAt = snap
      const later: Clock = {
        now: () => new Date("2026-09-19T17:20:00.000Z"),
        sleep: async () => undefined,
      }
      const engine = new SnapshotEngine(
        store,
        collector,
        new MockTreasury(() => store.config, async () => undefined),
        broadcast,
        later,
        new ScriptedRandom([]),
      )
      engine.ingestCallout({
        callerUsername: "gamma",
        wallet: walletC,
        source: "private-ingest",
        capturedAt: "2026-09-19T17:14:00.000Z",
        id: "pump_gamma",
        thesis: "new window",
      })
      await engine.flushQualifiedNotices()
      const sent = broadcast.sequence.filter((item) => item.kind === "qualified" && item.op === "send")
      expect(sent).toHaveLength(1)
      expect(sent[0]?.text).toContain("@gamma")
      expect(sent[0]?.text).toContain("Eligible this snapshot: 1")
      expect(sent[0]?.text).not.toContain("@alpha")
    } finally {
      spy.mockRestore()
      if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
      else process.env.TELEGRAM_BOT_TOKEN = prevToken
      if (prevChat === undefined) delete process.env.TELEGRAM_CHANNEL_ID
      else process.env.TELEGRAM_CHANNEL_ID = prevChat
    }
  })

  it("repost QUALIFIED when the same caller lands with a new Pump activity id", async () => {
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
    const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    engine.ingestCallout({
      callerUsername: "alpha",
      wallet,
      source: "pump-fun",
      capturedAt: "2026-09-19T17:01:00.000Z",
      id: "pump_1",
      thesis: "first take",
    })
    await engine.flushQualifiedNotices()
    const updated = engine.ingestCallout({
      callerUsername: "alpha",
      wallet,
      source: "pump-fun",
      capturedAt: "2026-09-19T17:02:00.000Z",
      id: "pump_2",
      thesis: "edited take",
    })
    expect(updated.id).toBe("pump_2")
    await engine.flushQualifiedNotices()
    const sent = broadcast.sequence.filter((item) => item.kind === "qualified" && item.op === "send")
    const edited = broadcast.sequence.filter((item) => item.kind === "qualified" && item.op === "edit")
    expect(sent).toHaveLength(1)
    expect(edited).toHaveLength(1)
    expect(sent[0]?.text).toContain("first take")
    expect(edited[0]?.text).toContain("edited take")
    expect(edited[0]?.text).toContain("Eligible this snapshot: 1")
    expect(broadcast.getMessages().filter((item) => item.kind === "qualified")).toHaveLength(1)
  })

  it("does not QUALIFIED-repost when only the Pump activity id changes", async () => {
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
    const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    engine.ingestCallout({
      callerUsername: "alpha",
      wallet,
      source: "pump-fun",
      capturedAt: "2026-09-19T17:01:00.000Z",
      id: "pump_1",
      thesis: "same take",
    })
    await engine.flushQualifiedNotices()
    engine.ingestCallout({
      callerUsername: "alpha",
      wallet,
      source: "pump-fun",
      capturedAt: "2026-09-19T17:02:00.000Z",
      id: "pump_2",
      thesis: "same take",
    })
    await engine.flushQualifiedNotices()
    const sent = broadcast.sequence.filter((item) => item.kind === "qualified" && item.op === "send")
    expect(sent).toHaveLength(1)
  })

  it("does not QUALIFIED-repost when the pin already has this qfp even if packed callouts are missing", async () => {
    const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    const fingerprint = `alpha:${wallet}#hello`
    const hash = createHash("sha1").update(fingerprint).digest("hex").slice(0, 16)
    const snap = "2026-09-19T17:13:00.000Z"
    const prevToken = process.env.TELEGRAM_BOT_TOKEN
    const prevChat = process.env.TELEGRAM_CHANNEL_ID
    process.env.TELEGRAM_BOT_TOKEN = "test-token"
    process.env.TELEGRAM_CHANNEL_ID = "-1001"
    const spy = vi.spyOn(persistWatch, "readQualifiedBoardFromPin").mockResolvedValue({
      qualifiedTelegramId: 801,
      qualifiedTelegramIds: [801],
      qualifiedFingerprintHash: hash,
      qualifiedCount: 1,
      lastSnapshotAt: snap,
      nextSnapshotAt: null,
      snapshotClaimId: null,
      schedulerPaused: null,
      rounds: [],
      migrationPaid: null,
      callouts: [],
    } satisfies PinBoardRef)
    try {
      const collector = new CalloutCollector()
      const broadcast = new RecordingBroadcast()
      const store = new EngineStore(
        () => collector.all(),
        () => broadcast.getMessages(),
        { ...DEFAULT_CONFIG, startupSnapshotDelayMs: null, feederEnabled: false },
        "2026-09-19T17:00:00.000Z",
      )
      store.lastSnapshotAt = snap
      const later: Clock = {
        now: () => new Date("2026-09-19T17:20:00.000Z"),
        sleep: async () => undefined,
      }
      const engine = new SnapshotEngine(
        store,
        collector,
        new MockTreasury(() => store.config, async () => undefined),
        broadcast,
        later,
        new ScriptedRandom([]),
      )
      engine.ingestCallout({
        callerUsername: "alpha",
        wallet,
        source: "pump-fun",
        capturedAt: "2026-09-19T17:14:00.000Z",
        id: "pump_other",
        thesis: "hello",
      })
      await engine.flushQualifiedNotices()
      expect(broadcast.sequence.filter((item) => item.kind === "qualified" && item.op === "send")).toHaveLength(
        0,
      )
    } finally {
      spy.mockRestore()
      if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
      else process.env.TELEGRAM_BOT_TOKEN = prevToken
      if (prevChat === undefined) delete process.env.TELEGRAM_CHANNEL_ID
      else process.env.TELEGRAM_CHANNEL_ID = prevChat
    }
  })
})
