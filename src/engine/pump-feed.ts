import { displayUsername } from "@/lib/format"
import { isValidWallet } from "@/engine/collector"

export type PumpCalloutRecord = {
  calloutId: string
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
  const iso = asString(row.calloutTimestamp) ?? asString(row.createdAtIso)
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
    coinMint,
    userId,
    username: displayUsername(username).replace(/^@/, ""),
    createdAtMs,
    thesis: asString(callout.thesis) ?? "",
  }
}

export function parseHomeFeedNewCallouts(payload: unknown): PumpCalloutRecord[] {
  const root = asRecord(payload)
  const coins = Array.isArray(root?.coins) ? root.coins : []
  return uniqueCallouts(
    coins.map(parseHomeFeedCoinCard).filter((row): row is PumpCalloutRecord => Boolean(row)),
  )
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
  return uniqueCallouts(rows.map(parsePumpCallout).filter((row): row is PumpCalloutRecord => Boolean(row)))
}

export function collectPumpCallouts(payload: unknown): PumpCalloutRecord[] {
  const found: PumpCalloutRecord[] = []
  const seen = new Set<object>()
  const visit = (value: unknown) => {
    if (value === null || typeof value !== "object") return
    if (seen.has(value)) return
    seen.add(value)
    const card = parseHomeFeedCoinCard(value)
    if (card) found.push(card)
    const parsed = parsePumpCallout(value)
    if (parsed) found.push(parsed)
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
    if (!byId.has(row.calloutId)) byId.set(row.calloutId, row)
  }
  return [...byId.values()]
}

/** @deprecated Peak-multiple ranking only — prefer pumpHomeFeedNewUrl for recent callouts. */
export function pumpCalloutApiUrl(mint: string, baseUrl?: string): string {
  const root = (baseUrl ?? "https://frontend-api-v3.pump.fun").replace(/\/$/, "")
  return `${root}/callout/top/${encodeURIComponent(mint)}?limit=50`
}

export function pumpHomeFeedNewUrl(baseUrl?: string, pageToken?: string | null): string {
  const root = (baseUrl ?? "https://frontend-api-v3.pump.fun").replace(/\/$/, "")
  const params = new URLSearchParams({
    pageSize: "50",
    chain: "all",
    platform: "WEB",
  })
  if (pageToken) params.set("pageToken", pageToken)
  return `${root}/home-feed/new?${params.toString()}`
}
