import { isDuplicateCalloutError } from "@/engine/collector"
import {
  drainFomoThesisAlerts,
  resolveFomoSolanaWallet,
  type FomoThesisRecord,
} from "@/engine/fomo-feed"
import { loadFomoWallet, saveFomoWallet } from "@/engine/fomo-wallets"
import type { Callout, EngineConfig } from "@/engine/types"

export type FomoPollerStatus = {
  enabled: boolean
  connected: boolean
  lastPollAt: string | null
  lastError: string | null
  lastFeedCount: number
  accepted: number
  skipped: number
  unresolved: number
  apiKeyConfigured: boolean
}

type IngestFn = (input: {
  token?: string
  callerUsername: string
  wallet: string
  source?: string
  capturedAt?: string
  id?: string
  thesis?: string
  silent?: boolean
  mint?: string
}) => Callout

const MIN_POLL_MS = 20_000

export class FomoThesesPoller {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private inFlight: Promise<FomoThesisRecord[]> | null = null
  private seenIds = new Set<string>()
  private unresolvedIds = new Set<string>()
  private walletCache = new Map<string, string>()
  private walletMissUntil = new Map<string, number>()
  private windowKey = ""
  private apiKey = ""
  private lastPollMs = 0
  /** Never burn 2,500-credit resolves when the bucket is empty. */
  private paidResolveEnabled = false
  connected = false
  lastPollAt: string | null = null
  lastError: string | null = null
  lastFeedCount = 0
  accepted = 0
  skipped = 0
  unresolved = 0

  constructor(
    private readonly ingest: IngestFn,
    private readonly config: () => EngineConfig,
    private readonly intervalMs: () => number,
    private readonly windowStart: () => Date,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly enabled: () => boolean = () => true,
    private readonly fomoApiBase?: string,
    private readonly onStatus?: (status: FomoPollerStatus) => void,
    initialApiKey = "",
    private readonly WebSocketImpl?: typeof WebSocket,
    /** Opt-in only — wallet REST costs 2,500 credits each. */
    enablePaidWalletResolve = false,
  ) {
    this.apiKey = initialApiKey.trim()
    this.paidResolveEnabled = enablePaidWalletResolve
  }

  status(): FomoPollerStatus {
    return {
      enabled: this.enabled() && Boolean(this.config().coinMint) && Boolean(this.apiKey),
      connected: this.connected,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      lastFeedCount: this.lastFeedCount,
      accepted: this.accepted,
      skipped: this.skipped,
      unresolved: this.unresolved,
      apiKeyConfigured: Boolean(this.apiKey),
    }
  }

  setApiKey(value: string | null) {
    this.apiKey = (value ?? "").trim()
    this.onStatus?.(this.status())
  }

  setPaidWalletResolve(enabled: boolean) {
    this.paidResolveEnabled = enabled
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  reset() {
    this.seenIds.clear()
    this.unresolvedIds.clear()
    this.walletCache.clear()
    this.walletMissUntil.clear()
    this.windowKey = ""
    this.lastPollMs = 0
    this.accepted = 0
    this.skipped = 0
    this.unresolved = 0
    this.lastFeedCount = 0
    this.lastError = null
    this.connected = false
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async pollOnce(now = Date.now(), force = false): Promise<FomoThesisRecord[]> {
    if (this.inFlight) return this.inFlight

    const cfg = this.config()
    const mint = cfg.coinMint
    if (!mint) {
      this.connected = false
      this.lastError = "No coin mint configured"
      this.onStatus?.(this.status())
      return []
    }
    if (!this.apiKey) {
      this.connected = false
      this.lastError = "FOMO_API_KEY required for app feed WebSocket"
      this.onStatus?.(this.status())
      return []
    }

    const cooldown = Math.max(MIN_POLL_MS, this.intervalMs())
    if (!force && this.lastPollMs > 0 && now - this.lastPollMs < cooldown) {
      return []
    }

    this.inFlight = this.runPoll(cfg, mint, now)
    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private async runPoll(
    cfg: EngineConfig,
    mint: string,
    now: number,
  ): Promise<FomoThesisRecord[]> {
    this.lastPollMs = now
    this.resetWindowCounters()

    const rows = await drainFomoThesisAlerts({
      apiKey: this.apiKey,
      tokenAddress: mint,
      apiBase: this.fomoApiBase,
      WebSocketImpl: this.WebSocketImpl,
    })
    this.lastFeedCount = rows.length
    const windowStartMs = this.windowStart().getTime()

    for (const row of rows) {
      if (this.seenIds.has(row.thesisId) || this.unresolvedIds.has(row.thesisId)) continue
      if (row.createdAtMs > now + 60_000) continue

      const resolvedWallet = await this.walletFor(row, now)
      const fomoFallback = cfg.fomoTreasuryWallet ?? null
      const wallet = resolvedWallet ?? fomoFallback
      if (!wallet) {
        this.unresolvedIds.add(row.thesisId)
        this.unresolved += 1
        this.lastError = `No wallet for @${row.traderHandle}`
        continue
      }

      try {
        this.ingest({
          token: cfg.distributionToken,
          callerUsername: row.traderHandle,
          wallet,
          source: "fomo",
          capturedAt: new Date(row.createdAtMs).toISOString(),
          id: `fomo_${row.thesisId}`,
          thesis: row.thesis,
          mint,
        })
        this.seenIds.add(row.thesisId)
        if (row.createdAtMs >= windowStartMs) this.accepted += 1
      } catch (error) {
        this.seenIds.add(row.thesisId)
        this.skipped += 1
        if (!isDuplicateCalloutError(error)) {
          this.lastError = error instanceof Error ? error.message : "Ingest failed"
        }
      }
    }

    this.connected = true
    this.lastError = null
    this.lastPollAt = new Date(now).toISOString()
    this.onStatus?.(this.status())
    return rows
  }

  private async walletFor(row: FomoThesisRecord, now: number): Promise<string | null> {
    if (row.walletAddress) {
      this.walletCache.set(row.traderHandle.toLowerCase(), row.walletAddress)
      void saveFomoWallet(row.traderHandle, row.walletAddress)
      return row.walletAddress
    }

    const cacheKey = row.traderHandle.toLowerCase()
    const cached = this.walletCache.get(cacheKey)
    if (cached) return cached

    const missUntil = this.walletMissUntil.get(cacheKey) ?? 0
    if (missUntil > now) return null

    const fromKv = await loadFomoWallet(row.traderHandle)
    if (fromKv) {
      this.walletCache.set(cacheKey, fromKv)
      return fromKv
    }

    if (!this.paidResolveEnabled || !this.apiKey) {
      this.walletMissUntil.set(cacheKey, now + 15 * 60_000)
      return null
    }

    try {
      const wallet = await resolveFomoSolanaWallet({
        handle: row.traderHandle,
        userId: row.traderId,
        apiKey: this.apiKey,
        apiBase: this.fomoApiBase,
        fetchImpl: this.fetchImpl,
      })
      if (wallet) {
        this.walletCache.set(cacheKey, wallet)
        void saveFomoWallet(row.traderHandle, wallet)
        return wallet
      }
      this.walletMissUntil.set(cacheKey, now + 30 * 60_000)
      return null
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Wallet resolve failed"
      this.lastError = msg
      this.paidResolveEnabled = false
      this.walletMissUntil.set(cacheKey, now + 30 * 60_000)
      return null
    }
  }

  private async tick() {
    if (this.stopped) return
    if (this.enabled() && this.config().coinMint && this.apiKey) {
      try {
        await this.pollOnce()
      } catch (error) {
        this.connected = false
        this.lastError = error instanceof Error ? error.message : "FOMO poll failed"
        this.onStatus?.(this.status())
      }
    } else {
      this.onStatus?.(this.status())
    }
    if (this.stopped) return
    const delay = Math.max(MIN_POLL_MS, this.intervalMs())
    this.timer = setTimeout(() => {
      void this.tick()
    }, delay)
  }

  private resetWindowCounters() {
    const key = this.windowStart().toISOString()
    if (key === this.windowKey) return
    this.windowKey = key
    this.accepted = 0
    this.skipped = 0
    this.unresolved = 0
  }
}
