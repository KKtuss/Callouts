import { describe, expect, it } from "vitest"
import { CalloutCollector } from "@/engine/collector"
import { MigrationMonitor } from "@/engine/migration-monitor"
import { DEFAULT_CONFIG, EngineStore } from "@/engine/store"
import { MockTreasury } from "@/engine/treasury"
import { AIDEN_MINT } from "@/lib/coin"
import { PreviewBroadcast, type Broadcast } from "@/telegram/broadcast"
import type { FormattedMessage } from "@/telegram/messages"

const walletA = "GC9gKkJjieLPTqDRtm3u6KzL7mhVvMdM4DfMa7aV44ke"
const walletB = "8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"

function syncLifetime(store: EngineStore, collector: CalloutCollector) {
  store.rememberLifetimeCallouts(collector.all())
}

describe("MigrationMonitor", () => {
  it("splits remaining treasury supply across bond lottery winners after bonding", async () => {
    const collector = new CalloutCollector()
    const store = new EngineStore(() => collector.all(), () => [], {
      ...DEFAULT_CONFIG,
      coinMint: AIDEN_MINT,
      distributionToken: "AIDEN",
      migrationBonusAmount: 10_000_000,
      migrationWinnerCount: 5,
      migrationMinCallouts: 3,
      mockTxDelayMs: 0,
    })
    store.watchStartedAt = "2026-09-19T16:00:00.000Z"
    store.treasuryBalance = 1_000_000_000

    for (let i = 0; i < 3; i += 1) {
      collector.ingest({
        id: `a${i}`,
        token: "AIDEN",
        callerUsername: "alpha",
        wallet: walletA,
        capturedAt: new Date(Date.parse("2026-09-19T16:10:00.000Z") + i * 60_000).toISOString(),
        source: "pump-fun",
      })
    }
    for (let i = 0; i < 3; i += 1) {
      collector.ingest({
        id: `b${i}`,
        token: "AIDEN",
        callerUsername: "beta",
        wallet: walletB,
        capturedAt: new Date(Date.parse("2026-09-19T16:20:00.000Z") + i * 60_000).toISOString(),
        source: "pump-fun",
      })
    }
    syncLifetime(store, collector)

    const treasury = new MockTreasury(() => store.config, async () => undefined, 1_000_000_000)
    store.treasuryBalance = treasury.balance

    const monitor = new MigrationMonitor(
      store,
      collector,
      treasury,
      { now: () => new Date("2026-09-19T18:00:00.000Z"), sleep: async () => undefined },
      { int: () => 0, bytes: () => Buffer.alloc(32, 1) },
      async (wallet) => wallet === walletA || wallet === walletB,
      async () =>
        new Response(JSON.stringify({ complete: true, symbol: "AIDEN", name: "Aiden" }), { status: 200 }),
    )

    const audit = await monitor.pollOnce()
    expect(audit?.confirmationStatus).toBe("confirmed")
    expect(audit?.winners).toHaveLength(2)
    expect(audit?.amount).toBe(1_000_000_000)
    expect(audit?.winners[0]?.amount).toBe(500_000_000)
    expect(audit?.winner?.wallet).toBe(walletB)
    expect(audit?.holderCount).toBe(2)
    expect(store.migrationPaid).toBe(true)
    expect(store.migrationBonded).toBe(true)
    expect(treasury.balance).toBe(0)
    expect(store.listMigrations()).toHaveLength(1)
  })

  it("skips when eligible callers no longer hold", async () => {
    const collector = new CalloutCollector()
    const store = new EngineStore(() => collector.all(), () => [], {
      ...DEFAULT_CONFIG,
      coinMint: AIDEN_MINT,
      distributionToken: "AIDEN",
      mockTxDelayMs: 0,
    })
    store.watchStartedAt = "2026-09-19T16:00:00.000Z"
    for (let i = 0; i < 3; i += 1) {
      collector.ingest({
        id: `a${i}`,
        token: "AIDEN",
        callerUsername: "alpha",
        wallet: walletA,
        capturedAt: new Date(Date.parse("2026-09-19T16:10:00.000Z") + i * 60_000).toISOString(),
        source: "pump-fun",
      })
    }
    syncLifetime(store, collector)
    const treasury = new MockTreasury(() => store.config, async () => undefined, 1_000_000_000)
    const monitor = new MigrationMonitor(
      store,
      collector,
      treasury,
      { now: () => new Date("2026-09-19T18:00:00.000Z"), sleep: async () => undefined },
      { int: () => 0, bytes: () => Buffer.alloc(32, 1) },
      async () => false,
      async () => new Response(JSON.stringify({ complete: true, symbol: "AIDEN" }), { status: 200 }),
    )

    const audit = await monitor.pollOnce()
    expect(audit?.confirmationStatus).toBe("skipped")
    expect(audit?.skipReason).toMatch(/none still hold/i)
    expect(store.migrationPaid).toBe(true)
  })

  it("tracks bonding progress without a dedicated bond channel message", async () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(() => collector.all(), () => broadcast.getMessages(), {
      ...DEFAULT_CONFIG,
      coinMint: AIDEN_MINT,
      distributionToken: "AIDEN",
      migrationBonusAmount: 10_000_000,
      migrationMinCallouts: 3,
      mockTxDelayMs: 0,
    })
    store.watchStartedAt = "2026-09-19T16:00:00.000Z"
    for (let i = 0; i < 3; i += 1) {
      collector.ingest({
        id: `a${i}`,
        token: "AIDEN",
        callerUsername: "alpha",
        wallet: walletA,
        capturedAt: new Date(Date.parse("2026-09-19T16:10:00.000Z") + i * 60_000).toISOString(),
        source: "pump-fun",
      })
    }
    syncLifetime(store, collector)

    const treasury = new MockTreasury(() => store.config, async () => undefined, 1_000_000_000)
    const clock = { now: () => new Date("2026-09-19T18:00:00.000Z"), sleep: async () => undefined }
    const random = { int: () => 0, bytes: () => Buffer.alloc(32, 1) }
    const holders = async (wallet: string) => wallet === walletA

    const filling = new MigrationMonitor(
      store,
      collector,
      treasury,
      clock,
      random,
      holders,
      async () =>
        new Response(
          JSON.stringify({ complete: false, symbol: "AIDEN", real_sol_reserves: 42_500_000_000 }),
          { status: 200 },
        ),
      broadcast,
    )
    expect(await filling.pollOnce()).toBeNull()
    expect(store.migrationProgressPercent).toBe(50)
    expect(broadcast.sequence.some((item) => item.kind === "bond")).toBe(false)

    const paying = new MigrationMonitor(
      store,
      collector,
      treasury,
      clock,
      random,
      holders,
      async () =>
        new Response(JSON.stringify({ complete: true, symbol: "AIDEN", real_sol_reserves: 85_000_000_000 }), {
          status: 200,
        }),
      broadcast,
    )
    const audit = await paying.pollOnce()
    expect(audit?.confirmationStatus).toBe("confirmed")
    expect(audit?.transaction?.signature).toBeTruthy()
    expect(store.migrationProgressPercent).toBe(100)
    const kinds = broadcast.sequence.map((item) => `${item.op}:${item.kind}`)
    expect(kinds).not.toContain("send:bond")
    expect(kinds).toContain("send:migration")
    expect(kinds.some((kind) => kind.endsWith(":distribution"))).toBe(true)
    expect(broadcast.sequence.some((item) => item.text.includes("BONDING LOTTERY SENT"))).toBe(true)
    expect(broadcast.sequence.some((item) => item.text.includes("TX:"))).toBe(true)
  })

  it("skips the lottery when the treasury is not live and does not telegram", async () => {
    const collector = new CalloutCollector()
    const broadcast = new RecordingBroadcast()
    const store = new EngineStore(() => collector.all(), () => broadcast.getMessages(), {
      ...DEFAULT_CONFIG,
      coinMint: AIDEN_MINT,
      distributionToken: "AIDEN",
      mockTxDelayMs: 0,
    })
    store.watchStartedAt = "2026-09-19T16:00:00.000Z"
    for (let i = 0; i < 3; i += 1) {
      collector.ingest({
        id: `a${i}`,
        token: "AIDEN",
        callerUsername: "alpha",
        wallet: walletA,
        capturedAt: new Date(Date.parse("2026-09-19T16:10:00.000Z") + i * 60_000).toISOString(),
        source: "pump-fun",
      })
    }
    syncLifetime(store, collector)

    class DryTreasury extends MockTreasury {
      override get live() {
        return false
      }
    }

    let persisted = 0
    const treasury = new DryTreasury(() => store.config, async () => undefined, 1_000_000_000)
    const monitor = new MigrationMonitor(
      store,
      collector,
      treasury,
      { now: () => new Date("2026-09-19T18:00:00.000Z"), sleep: async () => undefined },
      { int: () => 0, bytes: () => Buffer.alloc(32, 1) },
      async () => true,
      async () => new Response(JSON.stringify({ complete: true, symbol: "AIDEN" }), { status: 200 }),
      broadcast,
      () => {
        persisted += 1
      },
    )

    const audit = await monitor.pollOnce()
    expect(audit).toBeNull()
    expect(store.migrationPaid).toBe(true)
    expect(store.migrationBonded).toBe(true)
    expect(persisted).toBe(1)
    expect(treasury.balance).toBe(1_000_000_000)
    expect(broadcast.sequence).toHaveLength(0)
    expect(store.listMigrations()).toHaveLength(0)

    expect(await monitor.pollOnce()).toBeNull()
    expect(persisted).toBe(1)
  })
})

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
    const current = this.inner.getMessages().find((item) => item.id === id)
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

  async ensureIntro(_payload: Parameters<Broadcast["ensureIntro"]>[0], message: FormattedMessage) {
    this.sequence.push({ op: "send", kind: message.kind, text: message.text })
    return this.inner.ensureIntro(_payload, message)
  }

  async disablePublicCommands() {
    await this.inner.disablePublicCommands()
  }
}
