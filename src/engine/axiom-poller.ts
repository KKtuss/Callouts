import { isDuplicateCalloutError } from "@/engine/collector"
import {
  axiomCalloutsUrl,
  parseAxiomCalloutFeed,
  type AxiomCalloutRecord,
} from "@/engine/axiom-feed"
import type { Callout, EngineConfig } from "@/engine/types"

export type AxiomPollerStatus = {
  enabled: boolean
  connected: boolean
  lastPollAt: string | null
  lastError: string | null
  lastFeedCount: number
  accepted: number
  skipped: number
  cookieConfigured: boolean
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
}) => Callout

export class AxiomCalloutPoller {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private seenIds = new Set<string>()
  private windowKey = ""
  private cookie = ""
  connected = false
  lastPollAt: string | null = null
  lastError: string | null = null
  lastFeedCount = 0
  accepted = 0
  skipped = 0

  constructor(
    private readonly ingest: IngestFn,
    private readonly config: () => EngineConfig,
    private readonly intervalMs: () => number,
    private readonly windowStart: () => Date,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly enabled: () => boolean = () => true,
    private readonly apiBase?: string,
    private readonly onStatus?: (status: AxiomPollerStatus) => void,
    initialCookie = "",
  ) {
    this.cookie = initialCookie.trim()
  }

  status(): AxiomPollerStatus {
    return {
      enabled: this.enabled() && Boolean(this.config().coinMint) && Boolean(this.cookie),
      connected: this.connected,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      lastFeedCount: this.lastFeedCount,
      accepted: this.accepted,
      skipped: this.skipped,
      cookieConfigured: Boolean(this.cookie),
    }
  }

  setCookie(value: string | null) {
    this.cookie = (value ?? "").trim()
    this.onStatus?.(this.status())
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  reset() {
    this.seenIds.clear()
    this.windowKey = ""
    this.accepted = 0
    this.skipped = 0
    this.lastFeedCount = 0
    this.lastError = null
    this.connected = false
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async pollOnce(now = Date.now()): Promise<AxiomCalloutRecord[]> {
    const cfg = this.config()
    const mint = cfg.coinMint
    if (!mint) {
      this.connected = false
      this.lastError = "No coin mint configured"
      this.onStatus?.(this.status())
      return []
    }
    if (!this.cookie) {
      this.connected = false
      this.lastError = "Axiom cookie not configured (AXIOM_COOKIE)"
      this.onStatus?.(this.status())
      return []
    }

    this.resetWindowCounters()

    const rows = await this.loadMintCallouts(mint)
    this.lastFeedCount = rows.length
    const windowStartMs = this.windowStart().getTime()

    for (const row of rows) {
      if (this.seenIds.has(row.calloutId)) continue
      if (row.createdAtMs > now) continue
      try {
        this.ingest({
          token: cfg.distributionToken,
          callerUsername: row.username,
          wallet: row.wallet,
          source: "axiom",
          capturedAt: new Date(row.createdAtMs).toISOString(),
          id: `axiom_${row.calloutId}`,
          thesis: row.thesis,
        })
        this.seenIds.add(row.calloutId)
        if (row.createdAtMs >= windowStartMs) this.accepted += 1
      } catch (error) {
        this.seenIds.add(row.calloutId)
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

  private async loadMintCallouts(mint: string): Promise<AxiomCalloutRecord[]> {
    const response = await this.fetchImpl(axiomCalloutsUrl(mint, this.apiBase), {
      headers: {
        Accept: "application/json",
        "User-Agent": "callout-snap/0.1",
        Origin: "https://axiom.trade",
        Referer: "https://axiom.trade/",
        Cookie: this.cookie,
      },
      cache: "no-store",
    })

    if (response.status === 401 || response.status === 403) {
      throw new Error(`Axiom auth failed (HTTP ${response.status}) — refresh AXIOM_COOKIE`)
    }
    if (!response.ok) {
      throw new Error(`Axiom callouts HTTP ${response.status}`)
    }

    const payload: unknown = await response.json()
    return parseAxiomCalloutFeed(payload)
      .filter((row) => row.tokenAddress === mint)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
  }

  private async tick() {
    if (this.stopped) return
    if (this.enabled() && this.config().coinMint && this.cookie) {
      try {
        await this.pollOnce()
      } catch (error) {
        this.connected = false
        this.lastError = error instanceof Error ? error.message : "Axiom poll failed"
        this.onStatus?.(this.status())
      }
    } else {
      this.onStatus?.(this.status())
    }
    if (this.stopped) return
    const delay = Math.max(1_000, this.intervalMs())
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
  }
}
