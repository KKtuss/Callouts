import { isDuplicateCalloutError } from "@/engine/collector"
import {
  collectPumpCallouts,
  homeFeedNextPageToken,
  parseCalloutReplies,
  parseHomeFeedNewCallouts,
  parsePumpCalloutFeed,
  pumpCalloutApiUrl,
  pumpCalloutListUrl,
  pumpCalloutRepliesUrl,
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
  mint?: string
}) => Callout

function fetchInit(): RequestInit {
  return {
    headers: { Accept: "application/json", "User-Agent": "callout-snap/0.1" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  }
}

/** Pages of global newest feed to scan after mint switch / cold start. */
const BACKFILL_PAGES = 12
/** Extra pages on every live poll so a busy global feed does not hide this mint. */
const LIVE_PAGES = 6
/** Mint-scoped chronological pages. The list endpoint is empty for some coins. */
const LIST_BACKFILL_PAGES = 2
const LIST_LIVE_PAGES = 1
/** `/callout/top` does not include replies; fetch follow-ups for this many originals. */
const REPLY_FETCH_MAX = 20

export class PumpCalloutPoller {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private seenIds = new Set<string>()
  private windowKey = ""
  private needsBackfill = true
  private inFlight: Promise<PumpCalloutRecord[]> | null = null
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
    private readonly clampHistoricalIntoWindow: () => boolean = () => true,
    private readonly onPollComplete?: () => void | Promise<void>,
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
    if (this.inFlight) return this.inFlight
    this.inFlight = this.pollOnceNow(now).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async pollOnceNow(now: number): Promise<PumpCalloutRecord[]> {
    const cfg = this.config()
    const mint = cfg.coinMint
    if (!mint) {
      this.connected = false
      this.lastError = "No coin mint configured"
      return []
    }
    this.resetWindowCounters()
    this.lastError = null

    const backfill = this.needsBackfill
    const rows = await this.loadMintCallouts(mint)
    this.lastFeedCount = rows.length
    const windowStartMs = this.windowStart().getTime()
    let changed = false

    for (const row of rows) {
      if (this.seenIds.has(row.activityId)) continue
      if (row.createdAtMs > now + 120_000) continue
      const historical = backfill && row.createdAtMs < windowStartMs
      if (historical && !this.clampHistoricalIntoWindow()) {
        this.seenIds.add(row.activityId)
        this.skipped += 1
        continue
      }
      const capturedAtMs = historical ? windowStartMs : row.createdAtMs
      try {
        this.ingest({
          token: cfg.distributionToken,
          callerUsername: row.username,
          wallet: row.userId,
          source: "pump-fun",
          capturedAt: new Date(capturedAtMs).toISOString(),
          id: `pump_${row.activityId}`,
          thesis: row.thesis,
          silent: true,
          mint,
        })
        changed = true
        this.seenIds.add(row.activityId)
        if (capturedAtMs >= windowStartMs) this.accepted += 1
      } catch (error) {
        this.seenIds.add(row.activityId)
        this.skipped += 1
        if (!isDuplicateCalloutError(error)) {
          this.lastError = error instanceof Error ? error.message : "Ingest failed"
        }
      }
    }

    this.connected = true
    this.lastPollAt = new Date(now).toISOString()
    this.onStatus?.(this.status())
    if (changed) {
      try {
        await this.onPollComplete?.()
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : "Qualified sync failed"
      }
    }
    return rows
  }

  /**
   * Mint-scoped `/callout/top` + `/callout/list?sortBy=TIMESTAMP`, plus
   * global `/home-feed/new` filtered to this mint.
   */
  private async loadMintCallouts(mint: string): Promise<PumpCalloutRecord[]> {
    const found: PumpCalloutRecord[] = []
    const listPages = this.needsBackfill ? LIST_BACKFILL_PAGES : LIST_LIVE_PAGES
    const homePages = this.needsBackfill ? BACKFILL_PAGES : LIVE_PAGES

    const [topRows, listRows, homeFirst] = await Promise.all([
      this.fetchTop(mint),
      this.fetchListPage(mint, null),
      this.fetchHomePage(null),
    ])
    found.push(...topRows)
    found.push(...listRows.rows.filter((row) => row.coinMint === mint))
    found.push(...homeFirst.rows.filter((row) => row.coinMint === mint))

    let listToken = listRows.next
    for (let page = 1; page < listPages && listToken; page += 1) {
      const next = await this.fetchListPage(mint, listToken)
      found.push(...next.rows.filter((row) => row.coinMint === mint))
      listToken = next.next
    }

    let pageToken = homeFirst.next
    for (let page = 1; page < homePages && pageToken; page += 1) {
      const next = await this.fetchHomePage(pageToken)
      found.push(...next.rows.filter((row) => row.coinMint === mint))
      pageToken = next.next
    }

    this.needsBackfill = false
    const originals = uniqueById(found).filter(
      (row) => row.kind === "callout" && row.coinMint === mint,
    )
    const replyBatches = await Promise.all(
      originals.slice(0, REPLY_FETCH_MAX).map((row) => this.fetchReplies(row)),
    )
    found.push(...replyBatches.flat())
    return uniqueById(found).sort((a, b) => b.createdAtMs - a.createdAtMs)
  }

  private async fetchReplies(base: PumpCalloutRecord): Promise<PumpCalloutRecord[]> {
    try {
      const response = await this.fetchImpl(pumpCalloutRepliesUrl(base.calloutId, this.apiBase), fetchInit())
      if (!response.ok) return []
      return parseCalloutReplies(base, await response.json())
    } catch {
      return []
    }
  }

  private async fetchTop(mint: string): Promise<PumpCalloutRecord[]> {
    try {
      const top = await this.fetchImpl(pumpCalloutApiUrl(mint, this.apiBase), fetchInit())
      if (!top.ok) {
        this.lastError = `Pump callout/top HTTP ${top.status}`
        return []
      }
      return collectPumpCallouts(await top.json()).filter((row) => row.coinMint === mint)
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Pump callout/top failed"
      return []
    }
  }

  private async fetchListPage(
    mint: string,
    pageToken: string | null,
  ): Promise<{ rows: PumpCalloutRecord[]; next: string | null }> {
    try {
      const response = await this.fetchImpl(pumpCalloutListUrl(mint, this.apiBase, pageToken), fetchInit())
      if (response.status === 429) {
        return { rows: [], next: null }
      }
      if (!response.ok) {
        throw new Error(`Pump callout/list HTTP ${response.status}`)
      }
      const payload: unknown = await response.json()
      return {
        rows: parsePumpCalloutFeed(payload),
        next: homeFeedNextPageToken(payload),
      }
    } catch (error) {
      if (!this.lastError) {
        this.lastError = error instanceof Error ? error.message : "Pump callout/list failed"
      }
      return { rows: [], next: null }
    }
  }

  private async fetchHomePage(
    pageToken: string | null,
  ): Promise<{ rows: PumpCalloutRecord[]; next: string | null }> {
    try {
      const response = await this.fetchImpl(pumpHomeFeedNewUrl(this.apiBase, pageToken), fetchInit())
      if (!response.ok) {
        throw new Error(`Pump home-feed/new HTTP ${response.status}`)
      }
      const payload: unknown = await response.json()
      return {
        rows: parseHomeFeedNewCallouts(payload),
        next: homeFeedNextPageToken(payload),
      }
    } catch (error) {
      if (!this.lastError) {
        this.lastError = error instanceof Error ? error.message : "Pump home-feed failed"
      }
      return { rows: [], next: null }
    }
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

function uniqueById(rows: PumpCalloutRecord[]): PumpCalloutRecord[] {
  const byId = new Map<string, PumpCalloutRecord>()
  for (const row of rows) {
    if (!byId.has(row.activityId)) byId.set(row.activityId, row)
  }
  return [...byId.values()]
}
