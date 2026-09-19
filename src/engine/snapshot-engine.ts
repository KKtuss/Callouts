import { randomBytes } from "node:crypto"
import { nodeSecureRandom, pickIndex, type SecureRandom } from "@/lib/crypto-random"
import { isValidToken, DuplicateCalloutError, callerKey, type CalloutCollector } from "@/engine/collector"
import { selectRecipients, sortCallouts } from "@/engine/selection"
import { buildRouletteFrames } from "@/engine/roulette-animation"
import { EngineStore } from "@/engine/store"
import { txPending, type Treasury } from "@/engine/treasury"
import { resolveCalloutToken } from "@/lib/coin"
import { canonicalToken, tokensMatch } from "@/lib/format"
import type {
  Callout,
  DistributionTx,
  EngineConfig,
  RecipientSelection,
  SnapshotAudit,
  SnapshotTrigger,
} from "@/engine/types"
import type { Broadcast } from "@/telegram/broadcast"
import {
  distributionConfirmed,
  distributionPreparing,
  distributionSending,
  qualifiedCaller,
  rouletteSelected,
  rouletteSpin,
  rouletteStart,
  snapshotAnnouncement,
  snapshotFinal,
  snapshotRecipients,
  snapshotTaking,
} from "@/telegram/messages"

export type Clock = {
  now: () => Date
  sleep: (ms: number) => Promise<void>
}

export const realClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

function uniqueWindowCallouts(callouts: Callout[]): Callout[] {
  const seenUsers = new Set<string>()
  const seenWallets = new Set<string>()
  const unique: Callout[] = []
  for (const callout of sortCallouts(callouts)) {
    const user = callerKey(callout.callerUsername)
    if (seenUsers.has(user) || seenWallets.has(callout.wallet)) continue
    seenUsers.add(user)
    seenWallets.add(callout.wallet)
    unique.push(callout)
  }
  return unique
}

export class SnapshotEngine {
  private scheduler: ReturnType<typeof setTimeout> | null = null
  private firstSchedule = true

  constructor(
    private readonly store: EngineStore,
    private readonly collector: CalloutCollector,
    private readonly treasury: Treasury,
    private readonly broadcast: Broadcast,
    private readonly clock: Clock = realClock,
    private readonly random: SecureRandom = nodeSecureRandom,
  ) {}

  get config(): EngineConfig {
    return this.store.config
  }

  start() {
    void this.broadcast.disablePublicCommands()
    this.armScheduler(this.firstDelay())
    this.store.log("info", "Snapshot engine started. Telegram is broadcast-only.")
  }

  stop() {
    if (this.scheduler) clearTimeout(this.scheduler)
    this.scheduler = null
  }

  pause() {
    this.store.schedulerPaused = true
    this.store.nextSnapshotAt = null
    if (this.scheduler) clearTimeout(this.scheduler)
    this.scheduler = null
    this.store.log("info", "Scheduler paused. Existing callouts keep collecting.")
  }

  resume() {
    this.store.schedulerPaused = false
    this.armScheduler(this.randomDelay())
    this.store.log("info", "Scheduler resumed.")
  }

  setTreasuryPrivateKey(raw: string | null) {
    this.treasury.setSecretKey(raw)
    this.store.treasuryPublicAddress = this.treasury.publicAddress
    this.store.config = {
      ...this.store.config,
      treasuryPublicAddress: this.treasury.publicAddress,
    }
    this.store.treasuryKeyConfigured = this.treasury.keyConfigured
    this.store.log(
      "info",
      this.treasury.keyConfigured
        ? "Treasury private key loaded. Public address updated from keypair."
        : "Treasury private key cleared.",
    )
  }

  updateConfig(patch: Partial<EngineConfig>) {
    if (patch.allocationAmount !== undefined && patch.allocationAmount <= 0) {
      throw new Error("Allocation amount must be positive")
    }
    if (patch.migrationBonusAmount !== undefined && patch.migrationBonusAmount <= 0) {
      throw new Error("Migration bonus amount must be positive")
    }
    if (patch.migrationMinCallouts !== undefined && patch.migrationMinCallouts < 1) {
      throw new Error("Migration minimum callouts must be at least 1")
    }
    if (patch.snapshotMinMs !== undefined && patch.snapshotMinMs < 5_000) {
      throw new Error("Minimum snapshot interval is 5 seconds")
    }
    const nextMin = patch.snapshotMinMs ?? this.store.config.snapshotMinMs
    const nextMax = patch.snapshotMaxMs ?? this.store.config.snapshotMaxMs
    if (nextMax < nextMin) {
      throw new Error("Maximum interval must be >= minimum interval")
    }
    if (patch.distributionToken !== undefined) {
      if (this.store.config.coinMint) {
        const { distributionToken: _locked, ...rest } = patch
        patch = rest
      } else if (!isValidToken(patch.distributionToken)) {
        throw new Error("Invalid coin ticker")
      } else {
        patch = { ...patch, distributionToken: canonicalToken(patch.distributionToken) }
      }
    }
    if (patch.coinMint !== undefined) {
      const { coinMint: _mint, coinName: _name, ...rest } = patch
      patch = rest
    }
    if (patch.treasuryPublicAddress !== undefined) {
      const address = patch.treasuryPublicAddress.trim()
      if (!address) throw new Error("Treasury address is required")
      patch = { ...patch, treasuryPublicAddress: address }
      this.treasury.publicAddress = address
      this.store.treasuryPublicAddress = address
    }
    const timingChanged =
      (patch.snapshotMinMs !== undefined && patch.snapshotMinMs !== this.store.config.snapshotMinMs) ||
      (patch.snapshotMaxMs !== undefined && patch.snapshotMaxMs !== this.store.config.snapshotMaxMs)
    this.store.config = { ...this.store.config, ...patch }
    if (timingChanged && !this.store.schedulerPaused && !this.store.snapshotInProgress) {
      this.armScheduler(this.randomDelay())
    } else {
      this.store.emitState()
    }
  }

  ingestCallout(input: {
    token?: string
    callerUsername: string
    wallet: string
    source?: string
    capturedAt?: string
    id?: string
    thesis?: string
  }): Callout {
    const source = input.source ?? "private-ingest"
    if (!this.store.config.calloutSources.includes(source)) {
      throw new Error("Unknown callout source. Sources are configured privately.")
    }
    const token = resolveCalloutToken(input.token, this.store.config)
    const windowStart = new Date(this.store.lastSnapshotAt ?? this.store.startedAt)
    const { callout, duplicate } = this.collector.ingestUnique(
      {
        token,
        callerUsername: input.callerUsername,
        wallet: input.wallet,
        source,
        capturedAt: input.capturedAt,
        id: input.id,
        thesis: input.thesis,
      },
      windowStart,
    )
    if (duplicate) {
      throw new DuplicateCalloutError(callout)
    }
    this.store.emitState()
    this.notifyQualified(callout)
    return callout
  }

  private notifyQualified(callout: Callout) {
    if (this.store.snapshotInProgress) return
    const windowStartIso = this.store.lastSnapshotAt ?? this.store.startedAt
    if (callout.capturedAt < windowStartIso) return
    const windowStart = new Date(windowStartIso)
    const windowCount = uniqueWindowCallouts(
      this.collector
        .captureWindow(windowStart, this.clock.now())
        .filter((row) => tokensMatch(row.token, this.config.distributionToken)),
    ).length
    const explorer = {
      txTemplate: this.config.explorerTxTemplate,
      addressTemplate: this.config.explorerAddressTemplate,
    }
    void this.broadcast
      .send(qualifiedCaller({ callout, windowCount, explorer }))
      .catch((error) => {
        this.store.log("warn", error instanceof Error ? error.message : "Qualified notice failed")
      })
  }

  async runSnapshot(trigger: SnapshotTrigger = "admin"): Promise<SnapshotAudit | null> {
    if (this.store.snapshotInProgress) {
      throw new Error("A snapshot is already in progress")
    }

    this.store.snapshotInProgress = true
    this.store.phase = "capturing"
    this.store.emitState()

    const snapshotTimestamp = this.clock.now()
    const previous = this.store.lastSnapshotAt
    const windowStart = new Date(previous ?? this.store.startedAt)
    const callouts = uniqueWindowCallouts(
      this.collector
        .captureWindow(windowStart, snapshotTimestamp)
        .filter((callout) => tokensMatch(callout.token, this.config.distributionToken)),
    )

    if (callouts.length === 0) {
      const skipped = this.emptyAudit(trigger, snapshotTimestamp, windowStart)
      this.store.upsertAudit(skipped)
      this.store.snapshotInProgress = false
      this.store.phase = "idle"
      this.store.log("warn", "Snapshot skipped — no valid callouts in the window.")
      this.armScheduler(this.randomDelay())
      return skipped
    }

    // CRITICAL: commit selection with CSPRNG BEFORE any roulette animation.
    const selection = selectRecipients(callouts, snapshotTimestamp, this.random)
    const audit = this.createAudit(trigger, snapshotTimestamp, windowStart, callouts, selection)
    this.store.upsertAudit(audit)

    try {
      await this.broadcastLifecycle(audit, selection, callouts.length, windowStart, snapshotTimestamp)
      audit.confirmationStatus = audit.transactions.every((tx) => tx.status === "confirmed")
        ? "confirmed"
        : "partial_failure"
      audit.completedAt = this.clock.now().toISOString()
      this.store.lastSnapshotAt = audit.snapshotTimestamp
      this.store.upsertAudit(audit)
      return audit
    } finally {
      this.store.snapshotInProgress = false
      this.store.phase = "idle"
      this.store.emitState()
      if (!this.store.schedulerPaused) {
        this.armScheduler(this.randomDelay())
      }
    }
  }

  private async broadcastLifecycle(
    audit: SnapshotAudit,
    selection: RecipientSelection,
    calloutCount: number,
    windowStart: Date,
    snapshotTimestamp: Date,
  ) {
    const cfg = this.config
    const explorer = {
      txTemplate: cfg.explorerTxTemplate,
      addressTemplate: cfg.explorerAddressTemplate,
    }

    const snapshotMsg = await this.broadcast.send(snapshotTaking())
    audit.telegramMessageIds.snapshot = snapshotMsg.id
    await this.clock.sleep(500)
    await this.broadcast.edit(
      snapshotMsg.id,
      snapshotAnnouncement({
        calloutCount,
        windowStart,
        windowEnd: snapshotTimestamp,
      }),
    )

    this.store.phase = "roulette"
    audit.animationStartedAt = this.clock.now().toISOString()
    this.store.upsertAudit(audit)

    const frames = buildRouletteFrames(
      selection.roulettePool,
      selection.rouletteWinner,
      cfg.rouletteFrameCount,
      cfg.rouletteFrameMs,
      this.random,
    )

    const rouletteMsg = await this.broadcast.send(rouletteStart())
    audit.telegramMessageIds.roulette = rouletteMsg.id

    for (const frame of frames) {
      await this.clock.sleep(frame.delayMs)
      await this.broadcast.edit(rouletteMsg.id, rouletteSpin(frame.callerUsername))
    }

    await this.clock.sleep(Math.round(cfg.rouletteFrameMs * 1.2))
    // Always publish the precommitted winner — never the last animation frame.
    await this.broadcast.edit(
      rouletteMsg.id,
      rouletteSelected(selection.rouletteWinner, explorer),
    )

    this.store.phase = "announcing"
    const recipientsMsg = await this.broadcast.send(
      snapshotRecipients({
        lastCallout: selection.lastCallout,
        rouletteWinner: selection.rouletteWinner,
        allocationAmount: cfg.allocationAmount,
        distributionToken: cfg.distributionToken,
        explorer,
      }),
    )
    audit.telegramMessageIds.recipients = recipientsMsg.id

    this.store.phase = "distributing"
    const distMsg = await this.broadcast.send(distributionPreparing())
    audit.telegramMessageIds.distribution = distMsg.id

    const pendingLast = txPending({
      kind: "last_callout",
      calloutId: selection.lastCallout.id,
      token: selection.lastCallout.token,
      callerUsername: selection.lastCallout.callerUsername,
      wallet: selection.lastCallout.wallet,
      amount: cfg.allocationAmount,
      distributionToken: cfg.distributionToken,
    })
    const lastTx = await this.sendOne(distMsg.id, pendingLast, [])
    audit.transactions = [lastTx]
    this.store.treasuryBalance = this.treasury.balance
    this.store.upsertAudit(audit)

    const pendingRoulette = txPending({
      kind: "roulette",
      calloutId: selection.rouletteWinner.id,
      token: selection.rouletteWinner.token,
      callerUsername: selection.rouletteWinner.callerUsername,
      wallet: selection.rouletteWinner.wallet,
      amount: cfg.allocationAmount,
      distributionToken: cfg.distributionToken,
    })
    const rouletteTx = await this.sendOne(distMsg.id, pendingRoulette, [lastTx])
    audit.transactions = [lastTx, rouletteTx]
    audit.totalDistributed =
      (lastTx.status === "confirmed" ? lastTx.amount : 0) +
      (rouletteTx.status === "confirmed" ? rouletteTx.amount : 0)
    this.store.treasuryBalance = this.treasury.balance
    this.store.upsertAudit(audit)

    this.store.phase = "finalizing"
    const finalMsg = await this.broadcast.send(
      snapshotFinal({
        lastCallout: selection.lastCallout,
        rouletteWinner: selection.rouletteWinner,
        lastTx,
        rouletteTx,
        allocationAmount: cfg.allocationAmount,
        distributionToken: cfg.distributionToken,
        snapshotMinMs: cfg.snapshotMinMs,
        snapshotMaxMs: cfg.snapshotMaxMs,
        explorer,
      }),
    )
    audit.telegramMessageIds.final = finalMsg.id
    this.store.upsertAudit(audit)
  }

  private async sendOne(
    distributionMessageId: string,
    pending: DistributionTx,
    alreadyConfirmed: DistributionTx[],
  ): Promise<DistributionTx> {
    const explorer = {
      txTemplate: this.config.explorerTxTemplate,
      addressTemplate: this.config.explorerAddressTemplate,
    }
    await this.broadcast.edit(
      distributionMessageId,
      distributionSending(pending, alreadyConfirmed, explorer),
    )

    try {
      const result = await this.treasury.send({
        wallet: pending.wallet,
        amount: pending.amount,
        distributionToken: pending.distributionToken,
      })
      const confirmed: DistributionTx = {
        ...pending,
        signature: result.signature,
        explorerUrl: result.explorerUrl,
        status: "confirmed",
        confirmedAt: result.confirmedAt,
      }
      await this.broadcast.edit(
        distributionMessageId,
        distributionConfirmed([...alreadyConfirmed, confirmed], explorer),
      )
      return confirmed
    } catch (error) {
      const failed: DistributionTx = {
        ...pending,
        status: "failed",
        error: error instanceof Error ? error.message : "Treasury send failed",
      }
      await this.broadcast.edit(
        distributionMessageId,
        distributionConfirmed([...alreadyConfirmed, failed], explorer),
      )
      return failed
    }
  }

  private createAudit(
    trigger: SnapshotTrigger,
    snapshotTimestamp: Date,
    windowStart: Date,
    callouts: Callout[],
    selection: RecipientSelection,
  ): SnapshotAudit {
    return {
      id: `snap_${randomBytes(8).toString("hex")}`,
      trigger,
      snapshotTimestamp: snapshotTimestamp.toISOString(),
      previousSnapshotTimestamp: this.store.lastSnapshotAt,
      windowStart: windowStart.toISOString(),
      windowEnd: snapshotTimestamp.toISOString(),
      calloutCount: callouts.length,
      callouts: [...callouts],
      lastCallout: selection.lastCallout,
      rouletteCandidatePool: [...selection.roulettePool],
      rouletteIndex: selection.rouletteIndex,
      rouletteWinner: selection.rouletteWinner,
      selectionEntropyHex: selection.entropyHex,
      selectionMethod: selection.method,
      selectionCommittedAt: selection.selectedAt,
      animationStartedAt: null,
      allocationAmount: this.config.allocationAmount,
      distributionToken: this.config.distributionToken,
      totalDistributed: 0,
      transactions: [],
      confirmationStatus: "in_progress",
      skipReason: null,
      telegramMessageIds: {},
      createdAt: snapshotTimestamp.toISOString(),
      completedAt: null,
    }
  }

  private emptyAudit(trigger: SnapshotTrigger, snapshotTimestamp: Date, windowStart: Date): SnapshotAudit {
    return {
      id: `snap_${randomBytes(8).toString("hex")}`,
      trigger,
      snapshotTimestamp: snapshotTimestamp.toISOString(),
      previousSnapshotTimestamp: this.store.lastSnapshotAt,
      windowStart: windowStart.toISOString(),
      windowEnd: snapshotTimestamp.toISOString(),
      calloutCount: 0,
      callouts: [],
      lastCallout: {
        id: "none",
        token: "$NONE",
        callerUsername: "@none",
        wallet: "11111111111111111111111111111111",
        capturedAt: snapshotTimestamp.toISOString(),
        source: "none",
      },
      rouletteCandidatePool: [],
      rouletteIndex: -1,
      rouletteWinner: {
        id: "none",
        token: "$NONE",
        callerUsername: "@none",
        wallet: "11111111111111111111111111111111",
        capturedAt: snapshotTimestamp.toISOString(),
        source: "none",
      },
      selectionEntropyHex: "",
      selectionMethod: "node:crypto.randomInt",
      selectionCommittedAt: snapshotTimestamp.toISOString(),
      animationStartedAt: null,
      allocationAmount: this.config.allocationAmount,
      distributionToken: this.config.distributionToken,
      totalDistributed: 0,
      transactions: [],
      confirmationStatus: "skipped",
      skipReason: "No valid callouts in the snapshot window",
      telegramMessageIds: {},
      createdAt: snapshotTimestamp.toISOString(),
      completedAt: snapshotTimestamp.toISOString(),
    }
  }

  private firstDelay(): number {
    const startup = this.config.startupSnapshotDelayMs
    this.firstSchedule = false
    if (startup && startup > 0) return startup
    return this.randomDelay()
  }

  private randomDelay(): number {
    const min = this.config.snapshotMinMs
    const max = this.config.snapshotMaxMs
    return min + pickIndex(max - min + 1, this.random)
  }

  private armScheduler(delayMs: number) {
    if (this.store.schedulerPaused) {
      this.store.nextSnapshotAt = null
      this.store.emitState()
      return
    }
    if (this.scheduler) clearTimeout(this.scheduler)
    const next = new Date(this.clock.now().getTime() + delayMs)
    this.store.nextSnapshotAt = next.toISOString()
    this.store.emitState()
    this.scheduler = setTimeout(() => {
      void this.runSnapshot("scheduler").catch((error) => {
        this.store.log("error", error instanceof Error ? error.message : "Snapshot failed")
      })
    }, delayMs)
  }
}
