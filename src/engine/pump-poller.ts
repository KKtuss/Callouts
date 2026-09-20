import { isDuplicateCalloutError } from "@/engine/collector"
import {
  homeFeedNextPageToken,
  parseHomeFeedNewCallouts,
  pumpHomeFeedNewUrl,
  type PumpCalloutRecord,
} from "@/engine/pump-feed"
import type { Callout, EngineConfig } from "@/engine/types"

export type PumpPollerStatus = {
  enabled: boolean
  connected: boolean
  lastPollAt: string | null
  lastError: string | null
  lastFeedCount: number
  accepted: number
  skipped: number
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

const FETCH_INIT: RequestInit = {
  headers: { Accept: "application/json", "User-Agent": "callout-snap/0.1" },
  cache: "no-store",
}

/** Pages of global newest feed to scan after mint switch / cold start. */
const BACKFILL_PAGES = 12

export class PumpCalloutPoller {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private seenIds = new Set<string>()
  private windowKey = ""
  private needsBackfill = true
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
    private readonly onStatus?: (status: PumpPollerStatus) => void,
  ) {}

  status(): PumpPollerStatus {
    return {
      enabled: this.enabled() && Boolean(this.config().coinMint),
      connected: this.connected,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      lastFeedCount: this.lastFeedCount,
      accepted: this.accepted,
      skipped: this.skipped,
    }
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
    this.needsBackfill = true
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async pollOnce(now = Date.now()): Promise<PumpCalloutRecord[]> {
    const cfg = this.config()
    const mint = cfg.coinMint
    if (!mint) {
      this.connected = false
      this.lastError = "No coin mint configured"
      return []
    }
    this.resetWindowCounters()

    // Historical catch-up still counts toward the window, but must not spam QUALIFIED.
    const silent = this.needsBackfill
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
          wallet: row.userId,
          source: "pump-fun",
          capturedAt: new Date(row.createdAtMs).toISOString(),
          id: `pump_${row.calloutId}`,
          thesis: row.thesis,
          silent,
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

  /**
   * Pump has no mint-scoped chronological API. `/callout/top/{mint}` ranks by peak
   * multiple. Live newest callouts live on `/home-feed/new` (all coins) — we filter
   * to the watched mint. Steady state polls page 1; after reset we backfill several pages.
   */
  private async loadMintCallouts(mint: string): Promise<PumpCalloutRecord[]> {
    const pages = this.needsBackfill ? BACKFILL_PAGES : 1
    const found: PumpCalloutRecord[] = []
    let pageToken: string | null = null

    for (let page = 0; page < pages; page += 1) {
      const response = await this.fetchImpl(pumpHomeFeedNewUrl(this.apiBase, pageToken), FETCH_INIT)
      if (!response.ok) {
        throw new Error(`Pump home-feed/new HTTP ${response.status}`)
      }
      const payload: unknown = await response.json()
      found.push(...parseHomeFeedNewCallouts(payload).filter((row) => row.coinMint === mint))
      pageToken = homeFeedNextPageToken(payload)
      if (!pageToken) break
    }

    this.needsBackfill = false
    return uniqueById(found).sort((a, b) => b.createdAtMs - a.createdAtMs)
  }

  private async tick() {
    if (this.stopped) return
    if (this.enabled() && this.config().coinMint) {
      try {
        await this.pollOnce()
      } catch (error) {
        this.connected = false
        this.lastError = error instanceof Error ? error.message : "Pump poll failed"
        this.onStatus?.(this.status())
      }
    }
    if (this.stopped) return
    const delay = Math.max(2_000, this.intervalMs())
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

function uniqueById(rows: PumpCalloutRecord[]): PumpCalloutRecord[] {
  const byId = new Map<string, PumpCalloutRecord>()
  for (const row of rows) {
    if (!byId.has(row.calloutId)) byId.set(row.calloutId, row)
  }
  return [...byId.values()]
}
