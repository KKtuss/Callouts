import { randomBytes } from "node:crypto"
import { buildMigrationCandidates, selectMigrationWinner } from "@/engine/migration"
import type { CalloutCollector } from "@/engine/collector"
import { EngineStore } from "@/engine/store"
import { txPending, type Treasury } from "@/engine/treasury"
import type { MigrationAudit } from "@/engine/types"
import { fetchCoinBondingStatus, type CoinBondingStatus } from "@/lib/coin"
import { filterHolders, type HolderCheck, walletHoldsMint } from "@/lib/holder"
import { nodeSecureRandom, type SecureRandom } from "@/lib/crypto-random"
import type { Clock } from "@/engine/snapshot-engine"
import type { Broadcast } from "@/telegram/broadcast"
import {
  bondProgress,
  distributionConfirmed,
  distributionPreparing,
  distributionSending,
  migrationDetected,
  migrationFinal,
  migrationSkipped,
  migrationWinner,
} from "@/telegram/messages"

export class MigrationMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private running = false
  private watchedMint: string | null = null
  private bondMessageId: string | null = null
  private lastBondText: string | null = null

  constructor(
    private readonly store: EngineStore,
    private readonly collector: CalloutCollector,
    private readonly treasury: Treasury,
    private readonly clock: Clock,
    private readonly random: SecureRandom = nodeSecureRandom,
    private readonly holderCheck: HolderCheck = walletHoldsMint,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly broadcast: Broadcast | null = null,
  ) {}

  start() {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async pollOnce(): Promise<MigrationAudit | null> {
    if (this.running) return null
    this.running = true
    try {
      return await this.checkAndPay()
    } finally {
      this.running = false
    }
  }

  private async checkAndPay(): Promise<MigrationAudit | null> {
    const cfg = this.store.config
    const mint = cfg.coinMint
    if (!mint || this.store.migrationPaid) {
      this.store.migrationLastCheckAt = this.clock.now().toISOString()
      this.store.emitState()
      return null
    }

    if (this.watchedMint !== mint) {
      this.resetBondBroadcast()
      this.watchedMint = mint
    }

    const candidates = buildMigrationCandidates(this.collector.all(), cfg.migrationMinCallouts)
    this.store.migrationEligibleCount = candidates.length

    let status
    try {
      status = await fetchCoinBondingStatus(mint, this.fetchImpl)
      this.store.migrationLastError = null
    } catch (error) {
      this.store.migrationLastError = error instanceof Error ? error.message : "Migration check failed"
      this.store.migrationLastCheckAt = this.clock.now().toISOString()
      this.store.emitState()
      return null
    }

    this.applyBondProgress(status)
    await this.publishBondProgress(status, candidates.length)
    this.store.migrationLastCheckAt = this.clock.now().toISOString()
    if (!status.migrated) {
      this.store.emitState()
      return null
    }

    this.store.migrationBonded = true
    if (this.store.migrationPaid) {
      this.store.emitState()
      return null
    }

    return this.payMigrationBonus(mint, candidates)
  }

  private async payMigrationBonus(
    mint: string,
    candidates: ReturnType<typeof buildMigrationCandidates>,
  ): Promise<MigrationAudit> {
    const cfg = this.store.config
    const now = this.clock.now()
    const audit: MigrationAudit = {
      id: `mig_${randomBytes(8).toString("hex")}`,
      mint,
      distributionToken: cfg.distributionToken,
      detectedAt: now.toISOString(),
      watchStartedAt: this.store.watchStartedAt ?? this.store.startedAt,
      minCallouts: cfg.migrationMinCallouts,
      eligibleCount: candidates.length,
      holderCount: 0,
      winner: null,
      selectionEntropyHex: "",
      amount: cfg.migrationBonusAmount,
      transaction: null,
      confirmationStatus: "in_progress",
      skipReason: null,
      telegramMessageIds: {},
      completedAt: null,
    }
    this.store.upsertMigration(audit)
    if (this.bondMessageId) audit.telegramMessageIds.bond = this.bondMessageId

    await this.publishQuietly(
      migrationDetected({
        token: cfg.distributionToken,
        eligibleCount: candidates.length,
        bonusAmount: cfg.migrationBonusAmount,
        distributionToken: cfg.distributionToken,
      }),
      (id) => {
        audit.telegramMessageIds.detected = id
      },
    )

    if (candidates.length === 0) {
      return this.finishSkipped(
        audit,
        `No wallets with ≥${cfg.migrationMinCallouts} accepted callouts since monitoring started`,
      )
    }

    const holderWallets = await filterHolders(
      candidates.map((row) => row.wallet),
      mint,
      this.holderCheck,
    )
    audit.holderCount = holderWallets.length
    const holderSet = new Set(holderWallets)
    const holderCandidates = candidates.filter((row) => holderSet.has(row.wallet))

    if (holderCandidates.length === 0) {
      return this.finishSkipped(
        audit,
        `${candidates.length} eligible callers, but none still hold the token`,
      )
    }

    const selection = selectMigrationWinner(holderCandidates, now, this.random)
    audit.winner = {
      wallet: selection.winner.wallet,
      callerUsername: selection.winner.callerUsername,
      calloutCount: selection.winner.calloutCount,
    }
    audit.selectionEntropyHex = selection.entropyHex
    this.store.upsertMigration(audit)
    await this.publishQuietly(
      migrationWinner({
        callerUsername: selection.winner.callerUsername,
        wallet: selection.winner.wallet,
        calloutCount: selection.winner.calloutCount,
        amount: cfg.migrationBonusAmount,
        distributionToken: cfg.distributionToken,
        explorer: this.explorer(),
      }),
    )

    const pending = txPending({
      kind: "migration_bonus",
      calloutId: selection.winner.callouts[selection.winner.callouts.length - 1]?.id ?? selection.winner.wallet,
      token: cfg.distributionToken,
      callerUsername: selection.winner.callerUsername,
      wallet: selection.winner.wallet,
      amount: cfg.migrationBonusAmount,
      distributionToken: cfg.distributionToken,
    })
    audit.transaction = pending
    this.store.upsertMigration(audit)

    const distMsg = await this.publishQuietly(distributionPreparing(), (id) => {
      audit.telegramMessageIds.distribution = id
    })
    if (distMsg) {
      await this.editQuietly(distMsg.id, distributionSending(pending, [], this.explorer()))
    }

    try {
      const result = await this.treasury.send({
        wallet: selection.winner.wallet,
        amount: cfg.migrationBonusAmount,
        distributionToken: cfg.distributionToken,
      })
      pending.signature = result.signature
      pending.explorerUrl = result.explorerUrl
      pending.status = "confirmed"
      pending.confirmedAt = result.confirmedAt
      audit.confirmationStatus = "confirmed"
      audit.completedAt = this.clock.now().toISOString()
      this.store.treasuryBalance = this.treasury.balance
      this.store.migrationPaid = true
      this.store.upsertMigration(audit)
      this.store.log(
        "info",
        `Migration bonus: ${cfg.migrationBonusAmount} ${cfg.distributionToken} → ${selection.winner.callerUsername}`,
      )
    } catch (error) {
      pending.status = "failed"
      pending.error = error instanceof Error ? error.message : "Migration send failed"
      audit.confirmationStatus = "partial_failure"
      audit.skipReason = pending.error
      audit.completedAt = this.clock.now().toISOString()
      this.store.migrationPaid = true
      this.store.upsertMigration(audit)
      this.store.log("error", pending.error)
    }

    if (distMsg) {
      await this.editQuietly(distMsg.id, distributionConfirmed([pending], this.explorer()))
    }
    const finalMsg = await this.publishQuietly(
      migrationFinal({
        callerUsername: selection.winner.callerUsername,
        wallet: selection.winner.wallet,
        tx: pending,
        amount: cfg.migrationBonusAmount,
        distributionToken: cfg.distributionToken,
        explorer: this.explorer(),
      }),
      (id) => {
        audit.telegramMessageIds.final = id
      },
    )
    if (finalMsg) this.store.upsertMigration(audit)
    return audit
  }

  private async finishSkipped(audit: MigrationAudit, reason: string): Promise<MigrationAudit> {
    audit.confirmationStatus = "skipped"
    audit.skipReason = reason
    audit.completedAt = this.clock.now().toISOString()
    this.store.migrationPaid = true
    this.store.upsertMigration(audit)
    this.store.log("warn", reason)
    await this.publishQuietly(migrationSkipped(reason))
    return audit
  }

  private applyBondProgress(status: CoinBondingStatus) {
    this.store.migrationProgressPercent = status.progressPercent
    this.store.migrationSolRaised = status.solRaised
    this.store.migrationSolTarget = status.solTarget
  }

  private resetBondBroadcast() {
    this.bondMessageId = null
    this.lastBondText = null
  }

  private async publishBondProgress(status: CoinBondingStatus, eligibleCount: number) {
    if (!this.broadcast) return
    if (this.watchedMint !== status.mint) {
      this.resetBondBroadcast()
      this.watchedMint = status.mint
    }
    const message = bondProgress({
      token: this.store.config.distributionToken,
      percent: status.progressPercent,
      solRaised: status.solRaised,
      solTarget: status.solTarget,
      eligibleCount,
      minCallouts: this.store.config.migrationMinCallouts,
      bonded: status.migrated,
    })
    if (message.text === this.lastBondText) return
    try {
      if (!this.bondMessageId) {
        const sent = await this.broadcast.send(message)
        this.bondMessageId = sent.id
      } else {
        await this.broadcast.edit(this.bondMessageId, message)
      }
      this.lastBondText = message.text
    } catch (error) {
      this.store.log("warn", error instanceof Error ? error.message : "Bond progress publish failed")
    }
  }

  private explorer() {
    return {
      txTemplate: this.store.config.explorerTxTemplate,
      addressTemplate: this.store.config.explorerAddressTemplate,
    }
  }

  private async publishQuietly(
    message: Parameters<Broadcast["send"]>[0],
    remember?: (id: string) => void,
  ) {
    if (!this.broadcast) return null
    try {
      const sent = await this.broadcast.send(message)
      remember?.(sent.id)
      return sent
    } catch (error) {
      this.store.log("warn", error instanceof Error ? error.message : "Telegram publish failed")
      return null
    }
  }

  private async editQuietly(id: string, message: Parameters<Broadcast["edit"]>[1]) {
    if (!this.broadcast) return
    try {
      await this.broadcast.edit(id, message)
    } catch (error) {
      this.store.log("warn", error instanceof Error ? error.message : "Telegram edit failed")
    }
  }

  private async tick() {
    if (this.stopped) return
    if (this.store.config.coinMint && !this.store.migrationPaid) {
      try {
        await this.pollOnce()
      } catch (error) {
        this.store.migrationLastError = error instanceof Error ? error.message : "Migration poll failed"
        this.store.emitState()
      }
    }
    if (this.stopped) return
    const delay = Math.max(5_000, this.store.config.migrationPollMs)
    this.timer = setTimeout(() => {
      void this.tick()
    }, delay)
  }
}
