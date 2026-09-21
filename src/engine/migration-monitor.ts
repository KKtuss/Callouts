import { randomBytes } from "node:crypto"
import { buildMigrationCandidates, selectMigrationWinners } from "@/engine/migration"
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
  distributionConfirmed,
  distributionPreparing,
  distributionSending,
  migrationDetected,
  migrationFinal,
  migrationSkipped,
  migrationWinner,
} from "@/telegram/messages"
import { claimBondAnnouncement } from "@/engine/watch-kv"

export class MigrationMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private running = false

  constructor(
    private readonly store: EngineStore,
    private readonly collector: CalloutCollector,
    private readonly treasury: Treasury,
    private readonly clock: Clock,
    private readonly random: SecureRandom = nodeSecureRandom,
    private readonly holderCheck: HolderCheck = walletHoldsMint,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly broadcast: Broadcast | null = null,
    private readonly persistWatch: (() => Promise<void> | void) | null = null,
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

    const candidates = buildMigrationCandidates(
      this.store.listLifetimeCallouts(),
      cfg.migrationMinCallouts,
    )
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
    this.store.migrationLastCheckAt = this.clock.now().toISOString()
    if (!status.migrated) {
      if (!this.store.migrationSawOpen) {
        this.store.migrationSawOpen = true
        await this.persistQuietly()
      }
      this.store.emitState()
      return null
    }

    this.store.migrationBonded = true
    if (this.store.migrationPaid) {
      this.store.emitState()
      return null
    }

    // Already bonded when this watch started. Settle without a channel post.
    if (!this.store.migrationSawOpen) {
      this.store.migrationPaid = true
      this.store.log("info", "Already bonded when this watch started — lottery stays quiet")
      this.store.emitState()
      await this.persistQuietly()
      return null
    }

    const claimed = await claimBondAnnouncement(mint)
    if (claimed === "unavailable") {
      this.store.log("warn", "Bond lottery deferred — could not claim the announcement")
      this.store.emitState()
      return null
    }
    if (claimed === "taken") {
      this.store.migrationPaid = true
      this.store.log("info", "Bond lottery already announced by the live copy")
      this.store.emitState()
      await this.persistQuietly()
      return null
    }

    if (!this.treasury.live) {
      this.store.migrationPaid = true
      this.store.log(
        "info",
        "Bonded — lottery skipped (no treasury key). Marked settled so it will not replay.",
      )
      this.store.emitState()
      await this.persistQuietly()
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
    const winnerCount = Math.max(1, cfg.migrationWinnerCount || 5)

    await this.treasury.refreshBalance()
    const remainingSupply = Math.max(0, Math.floor(this.treasury.balance))

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
      winners: [],
      selectionEntropyHex: "",
      amount: remainingSupply,
      transaction: null,
      transactions: [],
      confirmationStatus: "in_progress",
      skipReason: null,
      telegramMessageIds: {},
      completedAt: null,
    }
    this.store.upsertMigration(audit)

    this.store.log(
      "info",
      `[wallet] Bond lottery starting | remaining=${remainingSupply} ${cfg.distributionToken} | seats=${winnerCount}`,
    )

    await this.publishQuietly(
      migrationDetected({
        eligibleCount: candidates.length,
        bonusAmount: remainingSupply,
        distributionToken: cfg.distributionToken,
        winnerCount,
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

    if (remainingSupply <= 0) {
      return this.finishSkipped(audit, "Treasury token balance is empty — nothing left to split")
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

    const selection = selectMigrationWinners(holderCandidates, winnerCount, now, this.random)
    const perWinner = Math.floor(remainingSupply / selection.winners.length)
    if (perWinner <= 0) {
      return this.finishSkipped(
        audit,
        `Remaining supply ${remainingSupply} is too small to split across ${selection.winners.length} winners`,
      )
    }

    audit.winners = selection.winners.map((row) => ({
      wallet: row.wallet,
      callerUsername: row.callerUsername,
      calloutCount: row.calloutCount,
      amount: perWinner,
    }))
    audit.winner = audit.winners[0] ?? null
    audit.selectionEntropyHex = selection.entropyHex
    audit.amount = perWinner * selection.winners.length
    this.store.upsertMigration(audit)

    await this.publishQuietly(
      migrationWinner({
        winners: audit.winners,
        distributionToken: cfg.distributionToken,
        explorer: this.explorer(),
      }),
    )

    const fomoTreasury = this.store.config.fomoTreasuryWallet
    const pendingTxs = audit.winners.map((row) => {
      const candidate = selection.winners.find((w) => w.wallet === row.wallet)
      const isFomo = candidate?.callouts.some((c) => c.source === "fomo") ?? false
      const destWallet = isFomo && fomoTreasury ? fomoTreasury : row.wallet
      if (isFomo && fomoTreasury) {
        this.store.log(
          "info",
          `[fomo-treasury] Bond lottery winner @${row.callerUsername} → FOMO treasury ${fomoTreasury.slice(0, 8)}… (manual distribution)`,
        )
      }
      return txPending({
        kind: "migration_bonus",
        calloutId: candidate?.callouts.at(-1)?.id ?? row.wallet,
        token: cfg.distributionToken,
        callerUsername: row.callerUsername,
        wallet: destWallet,
        amount: row.amount,
        distributionToken: cfg.distributionToken,
      })
    })
    audit.transactions = pendingTxs
    audit.transaction = pendingTxs[0] ?? null
    this.store.upsertMigration(audit)

    const distMsg = await this.publishQuietly(distributionPreparing(), (id) => {
      audit.telegramMessageIds.distribution = id
    })
    if (distMsg && pendingTxs[0]) {
      await this.editQuietly(distMsg.id, distributionSending(pendingTxs[0], pendingTxs.slice(1), this.explorer()))
    }

    let failures = 0
    for (const pending of pendingTxs) {
      try {
        this.store.log(
          "info",
          `[wallet] Bond lottery send ${pending.amount} ${pending.distributionToken} → ${pending.callerUsername}`,
        )
        const result = await this.treasury.send({
          wallet: pending.wallet,
          amount: pending.amount,
          distributionToken: pending.distributionToken,
        })
        pending.signature = result.signature
        pending.explorerUrl = result.explorerUrl
        pending.status = "confirmed"
        pending.confirmedAt = result.confirmedAt
      } catch (error) {
        failures += 1
        pending.status = "failed"
        pending.error = error instanceof Error ? error.message : "Migration send failed"
        this.store.log("error", `[wallet] Bond lottery send FAILED: ${pending.error}`)
      }
    }

    audit.transactions = pendingTxs
    audit.transaction = pendingTxs[0] ?? null
    audit.confirmationStatus =
      failures === 0 ? "confirmed" : failures === pendingTxs.length ? "partial_failure" : "partial_failure"
    if (failures === pendingTxs.length) {
      audit.skipReason = pendingTxs.find((tx) => tx.error)?.error ?? "All bond lottery sends failed"
    }
    audit.completedAt = this.clock.now().toISOString()
    this.store.treasuryBalance = this.treasury.balance
    this.store.migrationPaid = true
    this.store.migrationBonded = true
    this.store.upsertMigration(audit)
    this.store.log(
      "info",
      `[wallet] Bond lottery done | winners=${selection.winners.length} | each=${perWinner} | failures=${failures}`,
    )

    if (distMsg) {
      await this.editQuietly(distMsg.id, distributionConfirmed(pendingTxs, this.explorer()))
    }
    const finalMsg = await this.publishQuietly(
      migrationFinal({
        winners: audit.winners.map((row, i) => ({
          callerUsername: row.callerUsername,
          wallet: row.wallet,
          amount: row.amount,
          tx: pendingTxs[i]!,
        })),
        distributionToken: cfg.distributionToken,
        explorer: this.explorer(),
      }),
      (id) => {
        audit.telegramMessageIds.final = id
      },
    )
    if (finalMsg) this.store.upsertMigration(audit)
    await this.persistQuietly()
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
    await this.persistQuietly()
    return audit
  }

  private async persistQuietly() {
    if (!this.persistWatch) return
    try {
      await this.persistWatch()
    } catch (error) {
      this.store.log(
        "warn",
        error instanceof Error ? error.message : "Failed to persist bond-lottery settlement",
      )
    }
  }

  private applyBondProgress(status: CoinBondingStatus) {
    this.store.migrationProgressPercent = status.progressPercent
    this.store.migrationSolRaised = status.solRaised
    this.store.migrationSolTarget = status.solTarget
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
