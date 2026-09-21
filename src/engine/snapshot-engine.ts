import { createHash, randomBytes } from "node:crypto"
import { nodeSecureRandom, pickIndex, type SecureRandom } from "@/lib/crypto-random"
import { isValidToken, DuplicateCalloutError, callerKey, type CalloutCollector } from "@/engine/collector"
import { selectRecipients, sortCallouts } from "@/engine/selection"
import { buildRouletteFrames } from "@/engine/roulette-animation"
import { EngineStore } from "@/engine/store"
import { txPending, type Treasury } from "@/engine/treasury"
import { resolveCalloutToken } from "@/lib/coin"
import { canonicalToken, minutesLabel, tokensMatch } from "@/lib/format"
import {
  clearPinCache,
  compactCallouts,
  compactLifetimeCallouts,
  compactRound,
  expandCallouts,
  persistWatch,
  readPersistedWatch,
  readQualifiedBoardFromPin,
  siteUrlWithBoardRef,
} from "@/engine/persist-watch"
import type {
  Callout,
  DistributionTx,
  EngineConfig,
  RecipientSelection,
  SnapshotAudit,
  SnapshotTrigger,
} from "@/engine/types"
import type { Broadcast, ChannelIntroPayload } from "@/telegram/broadcast"
import {
  channelIntro,
  qualifiedCaller,
  rouletteSelected,
  rouletteSpin,
  rouletteStart,
  snapshotAnnouncement,
  snapshotPayout,
  snapshotTaking,
  withBondProgress,
  type BondSnippet,
  type FormattedMessage,
} from "@/telegram/messages"

export type Clock = {
  now: () => Date
  sleep: (ms: number) => Promise<void>
}

export const realClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

const SCHEDULER_DEBOUNCE_MS = 90_000
const SNAPSHOT_CLAIM_TTL_MS = 180_000
const SNAPSHOT_CLAIM_WAIT_MS = 700
const QUALIFIED_CLAIM_WAIT_MS = 700

function claimTimestampMs(sid: string): number | null {
  const dash = sid.indexOf("-")
  const prefix = dash === -1 ? sid : sid.slice(0, dash)
  const ms = Number.parseInt(prefix, 36)
  if (!Number.isFinite(ms) || ms < 1_600_000_000_000) return null
  return ms
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
  private qualifiedWindowKey = ""
  private qualifiedNotified = new Set<string>()
  private qualifiedMessageId: string | null = null
  private qualifiedTelegramId: number | null = null
  private qualifiedTelegramIds: number[] = []
  private qualifiedFingerprint: string | null = null
  private qualifiedFpHashFromPin: string | null = null
  private qualifiedCount = 0
  private qualifiedBoardChain: Promise<void> = Promise.resolve()
  private snapshotClaimId: string | null = null

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

  private bondSnippet(): BondSnippet | null {
    if (this.store.migrationBonded || this.store.migrationPaid) return null
    const percent = this.store.migrationProgressPercent
    if (percent == null) return null
    return {
      percent,
      solRaised: this.store.migrationSolRaised ?? 0,
      solTarget: this.store.migrationSolTarget,
      bonded: false,
    }
  }

  private decorate(message: FormattedMessage): FormattedMessage {
    return withBondProgress(message, this.bondSnippet())
  }

  private send(message: FormattedMessage) {
    return this.broadcast.send(this.decorate(message))
  }

  private edit(id: string, message: FormattedMessage) {
    return this.broadcast.edit(id, this.decorate(message))
  }

  private async delete(id: string) {
    try {
      await this.broadcast.delete(id)
    } catch (error) {
      this.store.log(
        "warn",
        error instanceof Error ? error.message : "Failed to delete Telegram message",
      )
    }
  }

  private async deleteTrackedQualifiedMessages() {
    await this.deleteQualifiedIds(this.trackedQualifiedIds(), null)
  }

  private rememberQualifiedTelegramId(id: number | null | undefined) {
    if (!id || !Number.isFinite(id) || id <= 0) return
    this.qualifiedTelegramId = id
    this.qualifiedTelegramIds = [id, ...this.qualifiedTelegramIds.filter((row) => row !== id)].slice(
      0,
      8,
    )
  }

  private async clearQualifiedBoard() {
    await this.qualifiedBoardChain
    await this.hydrateQualifiedBoardFromPin()
    await this.deleteTrackedQualifiedMessages()
    this.qualifiedMessageId = null
    this.qualifiedTelegramId = null
    this.qualifiedTelegramIds = []
    this.qualifiedFingerprint = null
    this.qualifiedFpHashFromPin = null
    this.qualifiedCount = 0
    this.persistQualifiedBoard()
    await this.publishChannelIntro(false)
  }

  private resetQualifiedNoticesIfNeeded() {
    const key = this.store.lastSnapshotAt ?? "pre-snapshot"
    if (key === this.qualifiedWindowKey) return
    this.qualifiedWindowKey = key
    this.qualifiedNotified.clear()
    this.qualifiedFingerprint = null
    this.qualifiedFpHashFromPin = null
    this.qualifiedCount = 0
  }

  private hydrateQualifiedBoard() {
    const persisted = readPersistedWatch()
    if (!persisted || persisted.mint !== this.config.coinMint) return
    if (!this.qualifiedTelegramId && persisted.qualifiedTelegramId) {
      this.rememberQualifiedTelegramId(persisted.qualifiedTelegramId)
    }
    if (!this.qualifiedFingerprint && persisted.qualifiedFingerprint) {
      this.qualifiedFingerprint = persisted.qualifiedFingerprint
    }
    this.store.hydrateLedger(persisted.lastSnapshotAt ?? null, persisted.rounds ?? [])
    if (this.store.lastSnapshotAt) this.collector.dropAtOrBefore(this.store.lastSnapshotAt)
  }

  private persistQualifiedBoard() {
    const mint = this.config.coinMint
    if (!mint) return
    void persistWatch({
      mint,
      ticker: this.config.distributionToken,
      name: this.config.coinName,
      qualifiedTelegramId: this.qualifiedTelegramId,
      qualifiedFingerprint: this.qualifiedFingerprint,
      lastSnapshotAt: this.store.lastSnapshotAt,
      callouts: compactCallouts(this.windowEligible()),
      lifetimeCallouts: compactLifetimeCallouts(this.store.listLifetimeCallouts()),
    })
  }

  private persistSnapshotLedger() {
    const mint = this.config.coinMint
    if (!mint) return
    void this.flushSnapshotLedger()
  }

  private async flushSnapshotLedger() {
    const mint = this.config.coinMint
    if (!mint) return
    await persistWatch({
      mint,
      ticker: this.config.distributionToken,
      name: this.config.coinName,
      lastSnapshotAt: this.store.lastSnapshotAt,
      nextSnapshotAt: this.store.nextSnapshotAt,
      schedulerPaused: this.store.schedulerPaused,
      rounds: this.store
        .listAudits()
        .filter(
          (audit) =>
            audit.confirmationStatus === "confirmed" ||
            audit.confirmationStatus === "partial_failure",
        )
        .slice(0, 50)
        .map(compactRound),
      migrationPaid: this.store.migrationPaid,
      callouts: compactCallouts(this.windowEligible()),
      lifetimeCallouts: compactLifetimeCallouts(this.store.listLifetimeCallouts()),
    })
  }

  /** Shared pin + durable ledger write after bond lottery settles (or is skipped). */
  async persistWatchState() {
    await this.flushSnapshotLedger()
    await this.publishChannelIntro(false)
  }

  private boardSiteUrl(siteBase: string) {
    return siteUrlWithBoardRef(siteBase, {
      qid: this.qualifiedTelegramId,
      qids: this.qualifiedTelegramIds,
      qfp: this.qualifiedFingerprint ? this.fingerprintHash(this.qualifiedFingerprint) : null,
      qn: this.qualifiedCount > 0 ? this.qualifiedCount : null,
      snap: this.store.lastSnapshotAt,
      next: this.store.schedulerPaused ? null : this.store.nextSnapshotAt,
      snapshotClaimId: this.snapshotClaimId,
      paused: this.store.schedulerPaused,
      paid: this.store.migrationPaid,
      callouts: compactCallouts(this.windowEligible()),
      rounds: this.store
        .listAudits()
        .filter(
          (audit) =>
            audit.confirmationStatus === "confirmed" ||
            audit.confirmationStatus === "partial_failure",
        )
        .slice(0, 1)
        .map(compactRound),
    })
  }

  private windowEligible(): Callout[] {
    const lastSnapshotAt = this.store.lastSnapshotAt
    const windowStart = new Date(lastSnapshotAt ?? this.store.startedAt)
    const rows = uniqueWindowCallouts(
      this.collector
        .captureWindow(windowStart, this.clock.now())
        .filter((row) => tokensMatch(row.token, this.config.distributionToken)),
    )
    if (!lastSnapshotAt) return rows
    return rows.filter((row) => row.capturedAt > lastSnapshotAt)
  }

  private eligibleFingerprint(rows: Callout[]): string {
    return rows
      .map(
        (row) =>
          `${callerKey(row.callerUsername)}:${row.wallet.trim()}#${row.thesis ?? ""}`,
      )
      .sort()
      .join("|")
  }

  private fingerprintIdentities(fingerprint: string | null): Set<string> {
    if (!fingerprint) return new Set()
    return new Set(fingerprint.split("|").map((part) => part.split("#")[0] ?? part))
  }

  private fingerprintHash(fingerprint: string): string {
    return createHash("sha1").update(fingerprint).digest("hex").slice(0, 16)
  }

  private newestCallout(rows: Callout[]): Callout | null {
    return sortCallouts(rows).at(-1) ?? null
  }

  /** Publish or refresh the single QUALIFIED board for the current window. */
  async syncQualifiedBoard() {
    this.hydrateQualifiedBoard()
    this.resetQualifiedNoticesIfNeeded()
    this.qualifiedBoardChain = this.qualifiedBoardChain
      .then(() => this.publishQualifiedBoardNow())
      .catch((error) => {
        this.store.log("warn", error instanceof Error ? error.message : "Qualified notice failed")
      })
    await this.qualifiedBoardChain
  }

  private pinConfigured() {
    return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHANNEL_ID?.trim())
  }

  private async publishQualifiedBoardNow() {
    if (this.store.snapshotInProgress) return
    if (this.pinConfigured()) {
      await this.hydrateQualifiedBoardFromPin(true)
    }
    this.resetQualifiedNoticesIfNeeded()
    const lastSnap = this.store.lastSnapshotAt
    const eligible = this.windowEligible().filter((row) => !lastSnap || row.capturedAt > lastSnap)
    // Empty/partial isolates must not delete a live board. Serverless
    // requests often see a subset of the window.
    if (eligible.length === 0) return
    const fingerprint = this.eligibleFingerprint(eligible)
    const hash = this.fingerprintHash(fingerprint)
    if (fingerprint === this.qualifiedFingerprint) return
    if (this.pinConfigured() && this.adoptPinBoard(hash, fingerprint, eligible.length)) return
    if (this.qualifiedCount > 0 && eligible.length < this.qualifiedCount) return
    const previousKeys = this.fingerprintIdentities(this.qualifiedFingerprint)
    const nextKeys = this.fingerprintIdentities(fingerprint)
    const coversPrevious =
      previousKeys.size === 0 || [...previousKeys].every((key) => nextKeys.has(key))
    if (!coversPrevious && eligible.length <= this.qualifiedCount) return
    if (
      previousKeys.size === 0 &&
      this.qualifiedFpHashFromPin &&
      this.qualifiedFpHashFromPin !== hash &&
      eligible.length <= this.qualifiedCount
    ) {
      return
    }
    const newcomers = previousKeys.size
      ? eligible.filter(
          (row) => !previousKeys.has(`${callerKey(row.callerUsername)}:${row.wallet.trim()}`),
        )
      : eligible
    const latest = this.newestCallout(newcomers) ?? this.newestCallout(eligible)
    if (!latest) return
    const explorer = {
      txTemplate: this.config.explorerTxTemplate,
      addressTemplate: this.config.explorerAddressTemplate,
    }
    await this.repostQualifiedBoard(eligible, latest, explorer, fingerprint, hash)
  }

  private adoptPinBoard(hash: string, fingerprint: string, eligibleCount: number): boolean {
    if (process.env.FORCE_QUALIFIED_REFRESH === "1") return false
    if (this.qualifiedFpHashFromPin !== hash || !this.qualifiedTelegramId) return false
    this.qualifiedFingerprint = fingerprint
    this.qualifiedCount = Math.max(this.qualifiedCount, eligibleCount)
    this.persistQualifiedBoard()
    return true
  }

  private async hydrateQualifiedBoardFromPin(fresh = false) {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
    const chatId = process.env.TELEGRAM_CHANNEL_ID?.trim()
    if (!token || !chatId) return
    if (fresh) clearPinCache()
    const pin = await readQualifiedBoardFromPin(token, chatId)
    if (pin.lastSnapshotAt || pin.rounds.length) {
      this.store.hydrateLedger(pin.lastSnapshotAt, pin.rounds)
    }
    if (this.store.lastSnapshotAt) this.collector.dropAtOrBefore(this.store.lastSnapshotAt)
    this.resetQualifiedNoticesIfNeeded()

    const ourSnap = this.store.lastSnapshotAt ? Date.parse(this.store.lastSnapshotAt) : 0
    const pinSnap = pin.lastSnapshotAt ? Date.parse(pin.lastSnapshotAt) : 0
    const pinIsCurrentWindow = !ourSnap || (pinSnap > 0 && pinSnap >= ourSnap)
    if (!pinIsCurrentWindow) return
    const pinCalloutsAfterSnap = pin.callouts.filter(
      (row) => !this.store.lastSnapshotAt || row.t > this.store.lastSnapshotAt,
    )

    this.qualifiedFpHashFromPin = pin.qualifiedFingerprintHash
    // Stale qn from a previous board must not block this window. qid/qfp still
    // apply so another isolate's live QUALIFIED is adopted instead of re-sent.
    if (
      pin.qualifiedCount &&
      pin.qualifiedCount > this.qualifiedCount &&
      (!this.store.lastSnapshotAt || pinCalloutsAfterSnap.length > 0)
    ) {
      this.qualifiedCount = pin.qualifiedCount
    }
    if (pinCalloutsAfterSnap.length) {
      this.collector.merge(
        expandCallouts(pinCalloutsAfterSnap, this.config.distributionToken),
        new Date(this.store.lastSnapshotAt ?? this.store.startedAt),
      )
    }
    for (const id of pin.qualifiedTelegramIds.length
      ? pin.qualifiedTelegramIds
      : pin.qualifiedTelegramId
        ? [pin.qualifiedTelegramId]
        : []) {
      if (!this.qualifiedTelegramIds.includes(id)) {
        this.qualifiedTelegramIds = [...this.qualifiedTelegramIds, id].slice(0, 8)
      }
      if (!this.qualifiedTelegramId) this.qualifiedTelegramId = id
    }
  }

  private trackedQualifiedIds() {
    const ids = new Set<string>()
    if (this.qualifiedMessageId) ids.add(this.qualifiedMessageId)
    if (this.qualifiedTelegramId) ids.add(String(this.qualifiedTelegramId))
    for (const id of this.qualifiedTelegramIds) ids.add(String(id))
    return ids
  }

  private async deleteQualifiedIds(
    ids: Iterable<string>,
    keep: number | string | null | Array<number | string | null | undefined>,
  ) {
    const keepSet = new Set(
      (Array.isArray(keep) ? keep : [keep])
        .filter((id): id is number | string => id != null && String(id).length > 0)
        .map(String),
    )
    for (const id of ids) {
      if (keepSet.has(id)) continue
      try {
        await this.broadcast.delete(id)
      } catch (error) {
        this.store.log(
          "warn",
          error instanceof Error ? error.message : "Failed to delete previous QUALIFIED board",
        )
      }
    }
  }

  start() {
    void this.broadcast.disablePublicCommands()
    // Never publish here. Cold starts often have mint=null; editing the pin
    // in that state blanks the mint and Telegram resends the presentation.
    if (!this.config.coinMint) {
      this.store.schedulerPaused = true
      this.store.nextSnapshotAt = null
      this.store.log("info", "Snapshot engine idle — waiting for SHILL tech to be live.")
      return
    }
    if (this.store.schedulerPaused) {
      this.store.nextSnapshotAt = null
      this.store.log("info", "Snapshot engine started (paused).")
      return
    }
    const nextMs = this.store.nextSnapshotAt ? Date.parse(this.store.nextSnapshotAt) : NaN
    if (Number.isFinite(nextMs) && nextMs > this.clock.now().getTime()) {
      this.armScheduler(nextMs - this.clock.now().getTime())
    }
    this.store.log("info", "Snapshot engine started. Telegram is broadcast-only.")
  }

  /** Re-arm the countdown after mint/config changes that cleared nextSnapshotAt. */
  rearmScheduler(delayMs?: number) {
    if (this.store.snapshotInProgress) return
    if (this.scheduler && this.store.nextSnapshotAt) {
      const next = Date.parse(this.store.nextSnapshotAt)
      if (Number.isFinite(next) && next > this.clock.now().getTime()) return
    }
    this.armScheduler(delayMs ?? this.randomDelay())
  }

  /** After hydrate: keep a live future deadline, otherwise arm one. */
  ensureArmed() {
    if (this.store.snapshotInProgress || this.store.schedulerPaused) return
    if (this.scheduler && this.store.nextSnapshotAt) {
      const next = Date.parse(this.store.nextSnapshotAt)
      if (Number.isFinite(next) && next > this.clock.now().getTime()) return
    }
    this.armScheduler(this.store.lastSnapshotAt ? this.randomDelay() : this.firstDelay())
  }

  /** Keep a deadline already published on the pin, instead of rolling a new window. */
  restoreDeadline(iso: string) {
    if (this.store.snapshotInProgress || this.store.schedulerPaused) return
    const target = Date.parse(iso)
    if (!Number.isFinite(target)) return
    const now = this.clock.now().getTime()
    const last = this.store.lastSnapshotAt ? Date.parse(this.store.lastSnapshotAt) : 0
    if (last && target <= last + 2_000) return
    if (last && now - last < SCHEDULER_DEBOUNCE_MS) return
    const ms = target - now
    if (ms <= 1_000) {
      if (this.scheduler) return
      this.armScheduler(2_000)
      return
    }
    const current = this.store.nextSnapshotAt ? Date.parse(this.store.nextSnapshotAt) : NaN
    if (this.scheduler && Number.isFinite(current) && Math.abs(current - target) < 2_000) return
    this.armScheduler(ms)
  }

  /** Permanent pinned intro — survives mint resets. Idle (no mint) is the waiting banner. */
  async publishChannelIntro(createIfMissing = false) {
    const cfg = this.config
    const ticker = cfg.distributionToken || "SHILL"
    const mint = cfg.coinMint
    if (!mint && !createIfMissing) return
    const siteBase =
      process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : "https://callout-beta.vercel.app")
    const telegramUrl = process.env.NEXT_PUBLIC_TELEGRAM_URL?.trim() || null
    const xUrl = process.env.NEXT_PUBLIC_X_URL?.trim() || null
    const payload: ChannelIntroPayload = {
      tokenName: cfg.coinName,
      ticker,
      mint,
      windowLabel: minutesLabel(cfg.snapshotMinMs, cfg.snapshotMaxMs),
      siteUrl: mint ? this.boardSiteUrl(siteBase) : siteBase,
      telegramUrl,
      xUrl,
      pumpUrl: mint ? `https://pump.fun/coin/${mint}` : null,
    }
    let message = channelIntro(payload)
    if (mint && message.html.length > 1024) {
      payload.siteUrl = siteUrlWithBoardRef(siteBase, {
        qid: this.qualifiedTelegramId,
        qids: this.qualifiedTelegramIds,
        qfp: this.qualifiedFingerprint ? this.fingerprintHash(this.qualifiedFingerprint) : null,
        qn: this.qualifiedCount > 0 ? this.qualifiedCount : null,
        snap: this.store.lastSnapshotAt,
        next: this.store.schedulerPaused ? null : this.store.nextSnapshotAt,
        snapshotClaimId: this.snapshotClaimId,
        paused: this.store.schedulerPaused,
        paid: this.store.migrationPaid,
      })
      message = channelIntro(payload)
    }
    try {
      await this.broadcast.ensureIntro(payload, message, {
        createIfMissing,
        allowClearMint: !mint,
      })
      clearPinCache()
    } catch (error) {
      this.store.log(
        "warn",
        error instanceof Error ? error.message : "Failed to publish Telegram intro",
      )
    }
  }

  stop() {
    if (this.scheduler) clearTimeout(this.scheduler)
    this.scheduler = null
  }

  pause() {
    const alreadyPaused = this.store.schedulerPaused && !this.scheduler && !this.store.nextSnapshotAt
    this.store.schedulerPaused = true
    this.store.nextSnapshotAt = null
    if (this.scheduler) clearTimeout(this.scheduler)
    this.scheduler = null
    if (alreadyPaused) {
      this.store.emitState()
      return
    }
    this.persistSnapshotLedger()
    this.store.log("info", "Scheduler paused. Existing callouts keep collecting.")
    void this.publishChannelIntro(false)
  }

  resume() {
    this.store.schedulerPaused = false
    this.armScheduler(this.randomDelay())
    this.store.log("info", "Scheduler resumed.")
    void this.publishChannelIntro(false)
  }

  setTreasuryPrivateKey(raw: string | null) {
    this.treasury.setSecretKey(raw)
    if (raw?.trim()) process.env.TREASURY_PRIVATE_KEY = raw.trim()
    else delete process.env.TREASURY_PRIVATE_KEY
    this.store.treasuryPublicAddress = this.treasury.publicAddress
    this.store.config = {
      ...this.store.config,
      treasuryPublicAddress: this.treasury.publicAddress,
    }
    this.store.treasuryKeyConfigured = this.treasury.keyConfigured
    void this.treasury.refreshBalance().then((balance) => {
      this.store.treasuryBalance = balance
      this.store.emitState()
    })
    this.store.log(
      "info",
      this.treasury.keyConfigured
        ? `[wallet] Treasury key loaded → ${this.treasury.publicAddress} (on-chain payouts enabled)`
        : "[wallet] Treasury private key cleared. Payouts fall back to mock.",
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
    /** Skip Telegram qualified notice (e.g. historical backfill). Still counts in the window. */
    silent?: boolean
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
      { replace: Boolean(input.id) },
    )
    if (duplicate) {
      throw new DuplicateCalloutError(callout)
    }
    this.store.rememberLifetimeCallout(callout)
    this.persistSnapshotLedger()
    this.store.emitState()
    if (!input.silent) void this.syncQualifiedBoard()
    return callout
  }

  private async repostQualifiedBoard(
    eligible: Callout[],
    latest: Callout,
    explorer: { txTemplate: string; addressTemplate: string },
    fingerprint: string,
    hash: string,
  ) {
    const message = qualifiedCaller({ callouts: eligible, latest, explorer })
    const staleIds = this.trackedQualifiedIds()
    const existingId =
      this.qualifiedMessageId ??
      (this.qualifiedTelegramId ? String(this.qualifiedTelegramId) : null)

    if (existingId) {
      try {
        const edited = await this.edit(existingId, message)
        this.qualifiedMessageId = edited.id
        this.rememberQualifiedTelegramId(edited.telegramMessageId ?? this.qualifiedTelegramId)
        this.qualifiedFingerprint = fingerprint
        this.qualifiedFpHashFromPin = hash
        this.qualifiedCount = eligible.length
        this.persistQualifiedBoard()
        await this.publishChannelIntro(false)
        await this.deleteQualifiedIds(staleIds, [
          edited.id,
          existingId,
          this.qualifiedTelegramId,
          edited.telegramMessageId,
        ])
        return
      } catch (error) {
        this.store.log(
          "warn",
          error instanceof Error ? error.message : "QUALIFIED edit failed — posting a new board",
        )
      }
    }

    if (this.pinConfigured()) {
      this.qualifiedFingerprint = fingerprint
      this.qualifiedFpHashFromPin = hash
      this.qualifiedCount = Math.max(this.qualifiedCount, eligible.length)
      this.qualifiedMessageId = null
      this.qualifiedTelegramId = null
      this.qualifiedTelegramIds = []
      this.persistQualifiedBoard()
      await this.publishChannelIntro(false)
      await this.clock.sleep(QUALIFIED_CLAIM_WAIT_MS)
      await this.hydrateQualifiedBoardFromPin(true)
      if (this.adoptPinBoard(hash, fingerprint, eligible.length)) {
        await this.deleteQualifiedIds(staleIds, this.qualifiedTelegramId)
        return
      }
    }

    await this.deleteQualifiedIds(staleIds, null)
    this.qualifiedMessageId = null
    this.qualifiedTelegramId = null
    this.qualifiedTelegramIds = []

    const sent = await this.send(message)
    this.qualifiedMessageId = sent.id
    this.rememberQualifiedTelegramId(sent.telegramMessageId)
    this.qualifiedFingerprint = fingerprint
    this.qualifiedFpHashFromPin = hash
    this.qualifiedCount = eligible.length
    this.persistQualifiedBoard()
    await this.publishChannelIntro(false)

    if (!this.pinConfigured() || !sent.telegramMessageId) return
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
    const chatId = process.env.TELEGRAM_CHANNEL_ID?.trim()
    if (!token || !chatId) return
    clearPinCache()
    const pin = await readQualifiedBoardFromPin(token, chatId)
    const winner =
      pin.qualifiedFingerprintHash === hash && pin.qualifiedTelegramId
        ? pin.qualifiedTelegramId
        : sent.telegramMessageId
    if (winner !== sent.telegramMessageId) {
      await this.deleteQualifiedIds([String(sent.telegramMessageId)], winner)
      this.qualifiedMessageId = null
      this.rememberQualifiedTelegramId(winner)
      this.persistQualifiedBoard()
    }
  }

  /** Wait for in-flight QUALIFIED delete/repost work (tests / shutdown). */
  async flushQualifiedNotices() {
    await this.qualifiedBoardChain
  }

  /**
   * First mint from idle: rewrite the waiting pin. Do not purge Telegram —
   * the channel is already empty except the pin.
   */
  async launchFromIdle() {
    await this.qualifiedBoardChain
    this.qualifiedNotified.clear()
    this.qualifiedWindowKey = ""
    this.qualifiedMessageId = null
    this.qualifiedTelegramId = null
    this.qualifiedTelegramIds = []
    this.qualifiedFingerprint = null
    this.qualifiedFpHashFromPin = null
    this.qualifiedCount = 0
    this.snapshotClaimId = null
    this.store.resetHistoryForMint()
    this.persistSnapshotLedger()
    this.persistQualifiedBoard()
    await this.publishChannelIntro(true)
  }

  /**
   * Drop the watched mint and park the channel on the waiting pin.
   * Optional Telegram purge is for leaving a live test mint, not for launch.
   */
  async enterIdle(options?: { purgeTelegram?: boolean }) {
    await this.qualifiedBoardChain
    await this.hydrateQualifiedBoardFromPin()
    await this.deleteTrackedQualifiedMessages()
    this.qualifiedNotified.clear()
    this.qualifiedWindowKey = ""
    this.qualifiedMessageId = null
    this.qualifiedTelegramId = null
    this.qualifiedTelegramIds = []
    this.qualifiedFingerprint = null
    this.qualifiedFpHashFromPin = null
    this.qualifiedCount = 0
    this.snapshotClaimId = null
    this.store.resetHistoryForMint()
    this.store.schedulerPaused = true
    this.store.nextSnapshotAt = null
    if (this.scheduler) {
      clearTimeout(this.scheduler)
      this.scheduler = null
    }
    this.store.config = {
      ...this.store.config,
      coinMint: null,
      coinName: null,
      pumpIngestEnabled: false,
      axiomIngestEnabled: false,
    }
    if (options?.purgeTelegram) {
      await this.broadcast.clear({ purgeTelegram: 5_000 })
    } else {
      await this.broadcast.clear()
    }
    await this.publishChannelIntro(true)
    this.store.log("info", "Idle — waiting for SHILL tech to be live.")
  }

  /**
   * Mint switch: wipe the Telegram channel board + local qualified tracking.
   * Purges recent channel posts (bots cannot list history).
   * The pinned intro is protected and refreshed afterward.
   */
  async resetForMintChange() {
    await this.qualifiedBoardChain
    await this.hydrateQualifiedBoardFromPin()
    await this.deleteTrackedQualifiedMessages()
    this.qualifiedNotified.clear()
    this.qualifiedWindowKey = ""
    this.qualifiedMessageId = null
    this.qualifiedTelegramId = null
    this.qualifiedTelegramIds = []
    this.qualifiedFingerprint = null
    this.qualifiedFpHashFromPin = null
    this.qualifiedCount = 0
    this.snapshotClaimId = null
    this.store.resetHistoryForMint()
    this.persistSnapshotLedger()
    this.persistQualifiedBoard()
    await this.broadcast.clear({ purgeTelegram: 5_000 })
    await this.publishChannelIntro(true)
  }

  /**
   * Same mint, new window: drop in-flight QUALIFIED, wipe the current callout
   * pool, re-arm snapshots. Snapshot payout posts stay in Telegram; the restart
   * purge only removes recent non-intro bot messages (stacked QUALIFIED / lottery).
   */
  async restartWatchCycle() {
    await this.qualifiedBoardChain
    await this.hydrateQualifiedBoardFromPin()
    const staleIds = new Set<string>()
    if (this.qualifiedMessageId) staleIds.add(this.qualifiedMessageId)
    if (this.qualifiedTelegramId) staleIds.add(String(this.qualifiedTelegramId))
    for (const id of this.qualifiedTelegramIds) staleIds.add(String(id))

    this.qualifiedNotified.clear()
    this.qualifiedWindowKey = ""
    this.qualifiedMessageId = null
    this.qualifiedTelegramId = null
    this.qualifiedTelegramIds = []
    this.qualifiedFingerprint = null
    this.qualifiedFpHashFromPin = null
    this.qualifiedCount = 0
    const at = this.clock.now().toISOString()
    this.store.resetWindowForNewCycle(at)
    this.collector.dropAtOrBefore(at)
    this.persistSnapshotLedger()
    this.persistQualifiedBoard()
    // Publish the new window on the pin before the slow purge so other
    // isolates stop replaying the previous QUALIFIED board.
    await this.publishChannelIntro(true)
    for (const id of staleIds) {
      try {
        await this.broadcast.delete(id)
      } catch {
        /* already gone */
      }
    }
    await this.broadcast.clear({ purgeTelegram: 500 })
    this.rearmScheduler()
    this.store.log(
      "info",
      "New cycle — QUALIFIED board cleared, window starts now. Snapshot payout posts were not replayed.",
    )
  }

  private async claimSnapshotSlot(trigger: SnapshotTrigger): Promise<boolean> {
    const now = this.clock.now().getTime()
    const last = this.store.lastSnapshotAt ? Date.parse(this.store.lastSnapshotAt) : 0
    if (trigger === "scheduler" && last && now - last < SCHEDULER_DEBOUNCE_MS) {
      this.store.log("info", "Scheduler snapshot skipped — a snapshot already ran in this window")
      if (!this.store.nextSnapshotAt || Date.parse(this.store.nextSnapshotAt) <= now) {
        this.armScheduler(this.randomDelay())
      }
      return false
    }

    const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
    const chatId = process.env.TELEGRAM_CHANNEL_ID?.trim()
    if (!token || !chatId) return true

    clearPinCache()
    const pin = await readQualifiedBoardFromPin(token, chatId)
    const pinSnap = pin.lastSnapshotAt ? Date.parse(pin.lastSnapshotAt) : 0
    if (pinSnap > last) {
      this.store.hydrateLedger(pin.lastSnapshotAt, pin.rounds)
    }
    const latestSnap = Math.max(last, pinSnap)
    if (trigger === "scheduler" && latestSnap && now - latestSnap < SCHEDULER_DEBOUNCE_MS) {
      this.store.log("info", "Scheduler snapshot skipped — pin already has a recent snapshot")
      return false
    }
    if (pin.snapshotClaimId && pin.snapshotClaimId !== this.snapshotClaimId) {
      const claimedAt = claimTimestampMs(pin.snapshotClaimId)
      if (!claimedAt || now - claimedAt < SNAPSHOT_CLAIM_TTL_MS) {
        this.store.log("info", "Snapshot skipped — another isolate already claimed this round")
        return false
      }
    }

    this.snapshotClaimId = `${now.toString(36)}-${randomBytes(4).toString("hex")}`
    this.persistSnapshotLedger()
    await this.publishChannelIntro(false)
    await this.clock.sleep(SNAPSHOT_CLAIM_WAIT_MS)
    clearPinCache()
    const again = await readQualifiedBoardFromPin(token, chatId)
    if (again.snapshotClaimId && again.snapshotClaimId !== this.snapshotClaimId) {
      this.store.log("info", "Snapshot skipped — lost pin claim")
      this.snapshotClaimId = null
      return false
    }
    const againSnap = again.lastSnapshotAt ? Date.parse(again.lastSnapshotAt) : 0
    if (trigger === "scheduler" && againSnap && now - againSnap < SCHEDULER_DEBOUNCE_MS) {
      this.store.hydrateLedger(again.lastSnapshotAt, again.rounds)
      this.snapshotClaimId = null
      return false
    }
    return true
  }

  async runSnapshot(trigger: SnapshotTrigger = "admin"): Promise<SnapshotAudit | null> {
    if (this.store.snapshotInProgress) {
      throw new Error("A snapshot is already in progress")
    }
    if (!(await this.claimSnapshotSlot(trigger))) {
      return null
    }

    this.store.snapshotInProgress = true
    this.store.phase = "capturing"
    this.store.emitState()
    this.walletLog(
      `Snapshot ${trigger} started | mint=${this.config.coinMint ?? "none"} | treasury=${this.treasury.publicAddress} | live=${this.treasury.keyConfigured}`,
    )
    await this.clearQualifiedBoard()

    const snapshotTimestamp = this.clock.now()
    const previous = this.store.lastSnapshotAt
    const windowStart = new Date(previous ?? this.store.startedAt)
    const callouts = uniqueWindowCallouts(
      this.collector
        .captureWindow(windowStart, snapshotTimestamp)
        .filter((callout) => tokensMatch(callout.token, this.config.distributionToken)),
    )

    if (callouts.length === 0) {
      this.snapshotClaimId = null
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
      this.store.rememberLifetimeCallouts(callouts)
      this.collector.dropAtOrBefore(audit.snapshotTimestamp)
      this.resetQualifiedNoticesIfNeeded()
      this.store.upsertAudit(audit)
      this.snapshotClaimId = null
      await this.flushSnapshotLedger()
      await this.publishChannelIntro(false)
      return audit
    } finally {
      this.snapshotClaimId = null
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

    const snapshotNumber = this.snapshotOrdinal(audit)
    const payoutNotice = (
      lastTx: DistributionTx | null,
      rouletteTx: DistributionTx | null,
      allocationAmount: number,
      distributionToken: string,
      pendingLabel: string | null,
    ) =>
      snapshotPayout({
        lastCallout: selection.lastCallout,
        rouletteWinner: selection.rouletteWinner,
        lastTx,
        rouletteTx,
        allocationAmount,
        distributionToken,
        snapshotMinMs: cfg.snapshotMinMs,
        snapshotMaxMs: cfg.snapshotMaxMs,
        explorer,
        pendingLabel,
        snapshotNumber,
      })

    const snapshotMsg = await this.send(snapshotTaking())
    audit.telegramMessageIds.snapshot = snapshotMsg.id
    await this.clock.sleep(500)
    await this.edit(
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

    const rouletteMsg = await this.send(rouletteStart())
    audit.telegramMessageIds.roulette = rouletteMsg.id

    for (const frame of frames) {
      await this.clock.sleep(frame.delayMs)
      await this.edit(rouletteMsg.id, rouletteSpin(frame.callerUsername))
    }

    await this.clock.sleep(Math.round(cfg.rouletteFrameMs * 1.2))
    // Always publish the precommitted winner — never the last animation frame.
    await this.edit(
      rouletteMsg.id,
      rouletteSelected(selection.rouletteWinner, explorer),
    )

    this.store.phase = "announcing"
    const bonded = this.store.migrationBonded
    const payoutMsg = await this.send(
      payoutNotice(
        null,
        null,
        cfg.allocationAmount,
        bonded ? "SOL" : cfg.distributionToken,
        bonded ? "Claiming creator rewards…" : "Sending rewards…",
      ),
    )
    audit.telegramMessageIds.final = payoutMsg.id
    audit.telegramMessageIds.recipients = payoutMsg.id
    audit.telegramMessageIds.distribution = payoutMsg.id
    this.store.upsertAudit(audit)

    this.store.phase = "distributing"
    let allocationAmount = cfg.allocationAmount
    let distributionToken = cfg.distributionToken
    let pendingLabel = "Sending rewards…"

    if (bonded) {
      const collect = await this.collectCreatorFeesForSnapshot()
      const shareBps = Math.max(0, this.config.creatorRewardShareBps || 1_000)
      const poolSol = (collect?.claimedSol ?? 0) * (shareBps / 10_000)
      if (poolSol > 0) {
        allocationAmount = poolSol / 2
        distributionToken = "SOL"
        pendingLabel = "Sending creator rewards…"
        this.walletLog(
          `Post-bond payout pool: ${poolSol.toFixed(6)} SOL (${shareBps / 100}% of claimed) → ${allocationAmount.toFixed(6)} SOL each`,
        )
      } else {
        this.walletLog(
          "Post-bond: no creator rewards claimed — paying token allocation instead of 0 SOL",
          "warn",
        )
      }
    } else {
      this.walletLog("Pre-bond: paying token supply — creator-fee collect waits until bond")
    }
    audit.allocationAmount = allocationAmount
    audit.distributionToken = distributionToken

    await this.edit(
      payoutMsg.id,
      payoutNotice(null, null, allocationAmount, distributionToken, pendingLabel),
    )

    const pendingLast = txPending({
      kind: "last_callout",
      calloutId: selection.lastCallout.id,
      token: selection.lastCallout.token,
      callerUsername: selection.lastCallout.callerUsername,
      wallet: selection.lastCallout.wallet,
      amount: allocationAmount,
      distributionToken,
    })
    const lastTx = await this.sendOne(
      payoutMsg.id,
      pendingLast,
      null,
      null,
      selection,
      allocationAmount,
      distributionToken,
      snapshotNumber,
      false,
    )
    audit.transactions = [lastTx]
    this.store.treasuryBalance = this.treasury.balance
    this.store.upsertAudit(audit)

    const pendingRoulette = txPending({
      kind: "roulette",
      calloutId: selection.rouletteWinner.id,
      token: selection.rouletteWinner.token,
      callerUsername: selection.rouletteWinner.callerUsername,
      wallet: selection.rouletteWinner.wallet,
      amount: allocationAmount,
      distributionToken,
    })
    const rouletteTx = await this.sendOne(
      payoutMsg.id,
      pendingRoulette,
      lastTx,
      null,
      selection,
      allocationAmount,
      distributionToken,
      snapshotNumber,
      false,
    )
    audit.transactions = [lastTx, rouletteTx]
    audit.totalDistributed =
      (lastTx.status === "confirmed" ? lastTx.amount : 0) +
      (rouletteTx.status === "confirmed" ? rouletteTx.amount : 0)
    this.store.treasuryBalance = this.treasury.balance

    this.store.phase = "finalizing"
    await this.editPayoutWithRetry(
      payoutMsg.id,
      payoutNotice(lastTx, rouletteTx, allocationAmount, distributionToken, null),
    )
    this.store.upsertAudit(audit)

    await this.broadcast.delete(snapshotMsg.id)
    await this.broadcast.delete(rouletteMsg.id)
  }

  private async sendOne(
    payoutMessageId: string,
    pending: DistributionTx,
    lastTx: DistributionTx | null,
    rouletteTx: DistributionTx | null,
    selection: RecipientSelection,
    allocationAmount: number,
    distributionToken: string,
    snapshotNumber: number,
    announce = true,
  ): Promise<DistributionTx> {
    const cfg = this.config
    const explorer = {
      txTemplate: cfg.explorerTxTemplate,
      addressTemplate: cfg.explorerAddressTemplate,
    }

    const paint = async (
      nextLast: DistributionTx | null,
      nextRoulette: DistributionTx | null,
      pendingLabel: string | null,
    ) => {
      if (!announce) return
      try {
        await this.edit(
          payoutMessageId,
          snapshotPayout({
            lastCallout: selection.lastCallout,
            rouletteWinner: selection.rouletteWinner,
            lastTx: nextLast,
            rouletteTx: nextRoulette,
            allocationAmount,
            distributionToken,
            snapshotMinMs: cfg.snapshotMinMs,
            snapshotMaxMs: cfg.snapshotMaxMs,
            explorer,
            pendingLabel,
            snapshotNumber,
          }),
        )
      } catch (error) {
        this.store.log(
          "warn",
          error instanceof Error ? error.message : "Payout Telegram edit failed",
        )
      }
    }

    const draftLast = pending.kind === "last_callout" ? pending : lastTx
    const draftRoulette = pending.kind === "roulette" ? pending : rouletteTx
    await paint(
      draftLast,
      draftRoulette,
      `Sending ${pending.kind === "last_callout" ? "last callout" : "roulette"} reward…`,
    )

    if (pending.amount <= 0) {
      const failed: DistributionTx = {
        ...pending,
        status: "failed",
        error:
          distributionToken === "SOL"
            ? "No creator rewards to distribute this round"
            : "Allocation amount must be positive",
      }
      this.walletLog(`Send skipped (${pending.kind}): ${failed.error}`, "warn")
      return failed
    }

    try {
      this.walletLog(
        `Send ${pending.kind}: ${pending.amount} ${pending.distributionToken} → ${pending.callerUsername} (${pending.wallet})`,
      )
      const result = await this.treasury.send({
        wallet: pending.wallet,
        amount: pending.amount,
        distributionToken: pending.distributionToken,
      })
      if (result.walletTrace) {
        const t = result.walletTrace
        this.walletLog(
          `Send confirmed ${result.signature.slice(0, 8)}… | treasury SOL ${(t.solBeforeLamports / 1e9).toFixed(4)}→${(t.solAfterLamports / 1e9).toFixed(4)} | token ${t.tokenBefore ?? "—"}→${t.tokenAfter ?? "—"}`,
        )
      } else {
        this.walletLog(`Send confirmed (mock) ${result.signature.slice(0, 12)}…`)
      }
      const confirmed: DistributionTx = {
        ...pending,
        signature: result.signature,
        explorerUrl: result.explorerUrl,
        status: "confirmed",
        confirmedAt: result.confirmedAt,
      }
      const nextLast = confirmed.kind === "last_callout" ? confirmed : lastTx
      const nextRoulette = confirmed.kind === "roulette" ? confirmed : rouletteTx
      await paint(
        nextLast,
        nextRoulette,
        nextLast && nextRoulette
          ? null
          : `Sending ${confirmed.kind === "last_callout" ? "roulette" : "last callout"} reward…`,
      )
      return confirmed
    } catch (error) {
      const failed: DistributionTx = {
        ...pending,
        status: "failed",
        error: error instanceof Error ? error.message : "Treasury send failed",
      }
      this.walletLog(`Send FAILED (${pending.kind}): ${failed.error}`, "error")
      const nextLast = failed.kind === "last_callout" ? failed : lastTx
      const nextRoulette = failed.kind === "roulette" ? failed : rouletteTx
      await paint(nextLast, nextRoulette, null)
      return failed
    }
  }

  private async editPayoutWithRetry(id: string, message: FormattedMessage) {
    let lastError: unknown
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await this.edit(id, message)
        return
      } catch (error) {
        lastError = error
        await this.clock.sleep(400 * 2 ** attempt)
      }
    }
    this.store.log(
      "warn",
      lastError instanceof Error
        ? `Payout Telegram edit failed after retries: ${lastError.message}`
        : "Payout Telegram edit failed after retries",
    )
  }

  private async collectCreatorFeesForSnapshot() {
    this.walletLog(
      `Creator fee collect starting | treasury=${this.treasury.publicAddress} | key=${this.treasury.keyConfigured ? "loaded" : "missing"} | mint=${this.config.coinMint ?? "none"}`,
    )
    try {
      const result = await this.treasury.collectCreatorFees()
      if (result.skippedReason) {
        this.walletLog(
          `Creator fee collect skipped: ${result.skippedReason} (vault ${result.beforeLamports} lamports)`,
          "warn",
        )
        return result
      }
      this.walletLog(
        `Creator fee collect OK | claimed ${result.claimedSol.toFixed(6)} SOL (${result.claimedLamports} lamports) | vault ${result.beforeLamports}→${result.afterLamports} | ixs=${result.instructionCount} | sig=${result.signature}`,
      )
      this.store.treasuryBalance = this.treasury.balance
      return result
    } catch (error) {
      this.walletLog(
        `Creator fee collect FAILED: ${error instanceof Error ? error.message : String(error)} — continuing with payouts`,
        "error",
      )
      return null
    }
  }

  private walletLog(message: string, level: "info" | "warn" | "error" = "info") {
    this.store.log(level, `[wallet] ${message}`)
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

  private snapshotOrdinal(audit: SnapshotAudit): number {
    const chronological = [...this.store.listAudits()].sort(
      (a, b) => Date.parse(a.snapshotTimestamp) - Date.parse(b.snapshotTimestamp),
    )
    const index = chronological.findIndex((row) => row.id === audit.id)
    return (index >= 0 ? index : chronological.length) + 1
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
      this.store.log("info", "[wallet] Snapshot scheduler paused — no next time armed")
      this.store.emitState()
      return
    }
    if (this.scheduler) clearTimeout(this.scheduler)
    const next = new Date(this.clock.now().getTime() + delayMs)
    this.store.nextSnapshotAt = next.toISOString()
    const secs = Math.max(1, Math.round(delayMs / 1000))
    const mins = Math.floor(secs / 60)
    const rem = secs % 60
    this.store.log(
      "info",
      `[wallet] Next snapshot in ${mins}m ${rem.toString().padStart(2, "0")}s → ${next.toISOString()} | mint=${this.config.coinMint ?? "none"}`,
    )
    this.persistSnapshotLedger()
    this.store.emitState()
    this.scheduler = setTimeout(() => {
      void this.runSnapshot("scheduler").catch((error) => {
        this.store.log("error", error instanceof Error ? error.message : "Snapshot failed")
      })
    }, delayMs)
  }
}
