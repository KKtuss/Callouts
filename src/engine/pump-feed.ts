import { displayUsername } from "@/lib/format"
import { isValidWallet } from "@/engine/collector"

export type PumpCalloutRecord = {
  calloutId: string
  /** Original callout id, or a follow-up update id. */
  activityId: string
  kind: "callout" | "update"
  coinMint: string
  userId: string
  username: string
  createdAtMs: number
  thesis: string
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function createdAtMsFrom(row: UnknownRecord): number | null {
  const ms = asNumber(row.createdAt)
  if (ms !== null) return ms
  const iso =
    asString(row.calloutTimestamp) ?? asString(row.createdAtIso) ?? asString(row.createdAt)
  if (!iso) return null
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : null
}

export function parsePumpCallout(raw: unknown): PumpCalloutRecord | null {
  const row = asRecord(raw)
  if (!row) return null

  const nested = asRecord(row.callout)
  if (nested && !asString(row.calloutId) && !asString(row.userId)) {
    return parsePumpCallout(nested)
  }

  const calloutId = asString(row.calloutId)
  const coinMint = asString(row.coinMint)
  const userId = asString(row.userId) ?? asString(row.walletAddress)
  const username = asString(row.username) ?? asString(row.userName)
  const createdAtMs = createdAtMsFrom(row)

  if (!calloutId || !coinMint || !userId || !username || createdAtMs === null) return null
  if (!isValidWallet(userId)) return null

  return {
    calloutId,
    activityId: calloutId,
    kind: "callout",
    coinMint,
    userId,
    username: displayUsername(username).replace(/^@/, ""),
    createdAtMs,
    thesis: asString(row.thesis) ?? "",
  }
}

/** Pump home-feed/new cards: coin → position → callout (chronological, all mints). */
export function parseHomeFeedCoinCard(raw: unknown): PumpCalloutRecord | null {
  const coin = asRecord(raw)
  if (!coin) return null
  const coinMint = asString(coin.coinMint)
  const position = asRecord(coin.position)
  if (!coinMint || !position) return null

  const callout = asRecord(position.callout)
  if (!callout) return null

  const calloutId = asString(callout.calloutId)
  const userId = asString(position.walletAddress) ?? asString(callout.userId)
  const username = asString(position.userName) ?? asString(callout.username) ?? asString(callout.userName)
  const createdAtMs = createdAtMsFrom(callout)
  if (!calloutId || !userId || !username || createdAtMs === null) return null
  if (!isValidWallet(userId)) return null

  return {
    calloutId,
    activityId: calloutId,
    kind: "callout",
    coinMint,
    userId,
    username: displayUsername(username).replace(/^@/, ""),
    createdAtMs,
    thesis: asString(callout.thesis) ?? "",
  }
}

/** Original callout plus each follow-up update (Pump only allows one original post). */
export function parseHomeFeedActivities(raw: unknown): PumpCalloutRecord[] {
  const base = parseHomeFeedCoinCard(raw)
  if (!base) return []
  const coin = asRecord(raw)
  const position = asRecord(coin?.position)
  const callout = asRecord(position?.callout)
  return [base, ...parseCalloutUpdates(base, callout)]
}

function parseCalloutUpdates(
  base: PumpCalloutRecord,
  callout: UnknownRecord | null,
): PumpCalloutRecord[] {
  if (!callout) return []
  return parseFollowUps(base, [
    ...(Array.isArray(callout.updates) ? callout.updates : []),
    ...(Array.isArray(callout.replies) ? callout.replies : []),
  ])
}

/**
 * Author follow-ups on `/callout/{id}/replies`. Pump keeps the original thesis
 * on `/callout/top` (`dabihgahh`) and puts later text (`innit`) here.
 */
export function parseCalloutReplies(
  base: PumpCalloutRecord,
  payload: unknown,
): PumpCalloutRecord[] {
  const root = asRecord(payload)
  const replies = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.replies)
      ? root.replies
      : Array.isArray(root?.comments)
        ? root.comments
        : []
  return parseFollowUps(base, replies)
}

function parseFollowUps(base: PumpCalloutRecord, items: unknown[]): PumpCalloutRecord[] {
  const rows: PumpCalloutRecord[] = []
  for (const item of items) {
    const rec = asRecord(item)
    if (!rec || rec.tombstone === true) continue
    const wallet = asString(rec.walletAddress)
    if (wallet && wallet !== base.userId) continue
    const activityId = asString(rec.id)
    const createdAtMs = createdAtMsFrom(rec)
    const thesis = asString(rec.content) ?? asString(rec.thesis) ?? ""
    if (!activityId || createdAtMs === null || !thesis) continue
    rows.push({
      ...base,
      activityId,
      kind: "update",
      createdAtMs,
      thesis,
    })
  }
  return rows
}

export function parseHomeFeedNewCallouts(payload: unknown): PumpCalloutRecord[] {
  const root = asRecord(payload)
  const coins = Array.isArray(root?.coins) ? root.coins : []
  return uniqueCallouts(coins.flatMap(parseHomeFeedActivities))
}

export function homeFeedNextPageToken(payload: unknown): string | null {
  const root = asRecord(payload)
  const token = asString(root?.nextPageToken)
  return token || null
}

export function parsePumpCalloutFeed(payload: unknown): PumpCalloutRecord[] {
  const root = asRecord(payload)
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.callouts)
      ? root.callouts
      : []
  return uniqueCallouts(
    rows.flatMap((raw) => {
      const parsed = parsePumpCallout(raw)
      if (!parsed) return []
      return [parsed, ...parseCalloutUpdates(parsed, asRecord(raw))]
    }),
  )
}

export function collectPumpCallouts(payload: unknown): PumpCalloutRecord[] {
  const found: PumpCalloutRecord[] = []
  const seen = new Set<object>()
  const visit = (value: unknown) => {
    if (value === null || typeof value !== "object") return
    if (seen.has(value)) return
    seen.add(value)
    const card = parseHomeFeedActivities(value)
    if (card.length) found.push(...card)
    const parsed = parsePumpCallout(value)
    if (parsed) found.push(parsed, ...parseCalloutUpdates(parsed, asRecord(value)))
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    for (const child of Object.values(value as UnknownRecord)) visit(child)
  }
  visit(payload)
  return uniqueCallouts(found)
}

function uniqueCallouts(rows: PumpCalloutRecord[]): PumpCalloutRecord[] {
  const byId = new Map<string, PumpCalloutRecord>()
  for (const row of rows) {
    if (!byId.has(row.activityId)) byId.set(row.activityId, row)
  }
  return [...byId.values()]
}

function pumpApiRoot(baseUrl?: string): string {
  return (baseUrl ?? "https://frontend-api-v3.pump.fun").replace(/\/$/, "")
}

/** Peak-multiple ranking for a mint. Pump's coin page uses this board. */
export function pumpCalloutApiUrl(mint: string, baseUrl?: string): string {
  return `${pumpApiRoot(baseUrl)}/callout/top/${encodeURIComponent(mint)}?limit=50`
}

/** Author replies / follow-up posts on one original callout. */
export function pumpCalloutRepliesUrl(calloutId: string, baseUrl?: string): string {
  return `${pumpApiRoot(baseUrl)}/callout/${encodeURIComponent(calloutId)}/replies`
}

/** Mint-scoped chronological feed. Requires sortBy=TIMESTAMP or MULTIPLE. */
export function pumpCalloutListUrl(
  mint: string,
  baseUrl?: string,
  pageToken?: string | null,
): string {
  const params = new URLSearchParams({
    limit: "50",
    sortBy: "TIMESTAMP",
    sortOrder: "DESC",
  })
  if (pageToken) params.set("pageToken", pageToken)
  return `${pumpApiRoot(baseUrl)}/callout/list/${encodeURIComponent(mint)}?${params.toString()}`
}

export function pumpHomeFeedNewUrl(baseUrl?: string, pageToken?: string | null): string {
  const params = new URLSearchParams({
    pageSize: "50",
    chain: "all",
    platform: "WEB",
  })
  if (pageToken) params.set("pageToken", pageToken)
  return `${pumpApiRoot(baseUrl)}/home-feed/new?${params.toString()}`
}
