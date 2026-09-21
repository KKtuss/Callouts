import { createHash } from "node:crypto"
import { isValidWallet } from "@/engine/collector"
import { displayUsername } from "@/lib/format"

export type FomoThesisRecord = {
  thesisId: string
  tokenAddress: string | null
  traderId: string | null
  traderHandle: string
  createdAtMs: number
  thesis: string
  walletAddress: string | null
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

function createdAtMsFrom(row: UnknownRecord): number | null {
  const iso = asString(row.createdAt) ?? asString(row.ts)
  if (iso) {
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) return parsed
  }
  const n = row.ts
  if (typeof n === "number" && Number.isFinite(n)) {
    return n < 1e12 ? n * 1000 : n
  }
  return null
}

function tokenAddressFrom(row: UnknownRecord): string | null {
  const direct = asString(row.tokenAddress) ?? asString(row.address)
  if (direct) return direct
  const token = asRecord(row.token)
  return asString(token?.address)
}

function isSolanaChain(row: UnknownRecord): boolean {
  const chain = (asString(row.chain) ?? "solana").toLowerCase()
  if (chain === "sol" || chain === "solana") return true
  const networkId = row.networkId ?? row.chainId
  if (typeof networkId === "number" && networkId === 1_399_811_149) return true
  if (typeof networkId === "string" && networkId === "1399811149") return true
  return false
}

function stableThesisId(row: UnknownRecord, handle: string, createdAtMs: number, text: string, mint: string) {
  const explicit =
    asString(row.id) ??
    asString(row.eventId) ??
    asString(row.thesisId) ??
    asString(row.tradeId)
  if (explicit) return explicit
  return createHash("sha1")
    .update(`${mint}|${handle}|${createdAtMs}|${text}`)
    .digest("hex")
    .slice(0, 24)
}

/** Strip "handle posted a thesis on $TICKER: " wrapper from WS alert text. */
export function thesisBodyFromAlertText(text: string, handle?: string | null): string {
  const raw = text.trim()
  if (!raw) return ""
  const posted = raw.match(/posted a thesis on \$[^:]+:\s*([\s\S]+)$/i)
  if (posted?.[1]) return posted[1].trim()
  if (handle) {
    const re = new RegExp(`^@?${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`, "i")
    return raw.replace(re, "").trim()
  }
  return raw
}

export function parseFomoThesis(raw: unknown, preferMint?: string | null): FomoThesisRecord | null {
  const row = asRecord(raw)
  if (!row) return null
  if (!isSolanaChain(row)) return null

  const alertType = asString(row.alertType)?.toLowerCase()
  if (alertType && alertType !== "thesis") return null

  const tokenAddress = tokenAddressFrom(row)
  if (!tokenAddress) return null
  if (preferMint && tokenAddress !== preferMint) return null

  const traderHandle =
    asString(row.traderHandle) ??
    asString(row.trader) ??
    asString(row.userHandle) ??
    asString(row.handle)
  const createdAtMs = createdAtMsFrom(row) ?? Date.now()
  if (!traderHandle) return null

  const handle = displayUsername(traderHandle).replace(/^@/, "")
  const rawText =
    asString(row.body) ??
    asString(row.text) ??
    asString(row.thesis) ??
    asString(asRecord(row.raw)?.text) ??
    ""
  const thesis = thesisBodyFromAlertText(rawText, handle)
  const walletRaw =
    asString(row.walletAddress) ??
    asString(row.wallet) ??
    asString(row.solanaWallet)
  const walletAddress = walletRaw && isValidWallet(walletRaw) ? walletRaw : null

  return {
    thesisId: stableThesisId(row, handle, createdAtMs, thesis, tokenAddress),
    tokenAddress,
    traderId: asString(row.traderId) ?? asString(row.userId),
    traderHandle: handle,
    createdAtMs,
    thesis,
    walletAddress,
  }
}

export function parseFomoThesisFeed(
  payload: unknown,
  preferMint?: string | null,
): FomoThesisRecord[] {
  const root = asRecord(payload)
  if (root?.available === false) return []

  const rows = extractRows(payload)
  const parsed = rows
    .map((row) => parseFomoThesis(row, preferMint))
    .filter((row): row is FomoThesisRecord => Boolean(row))
  const byId = new Map<string, FomoThesisRecord>()
  for (const row of parsed) {
    if (!byId.has(row.thesisId)) byId.set(row.thesisId, row)
  }
  return [...byId.values()]
}

function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  const root = asRecord(payload)
  if (!root) return []
  if (Array.isArray(root.theses)) return root.theses
  if (Array.isArray(root.data)) return root.data
  if (Array.isArray(root.items)) return root.items
  if (Array.isArray(root.callouts)) return root.callouts
  if (Array.isArray(root.alerts)) return root.alerts
  return []
}

/** Unmetered app feed — same theses FOMO shows in-app. */
export function fomoAlertsWsUrl(input: {
  apiKey: string
  tokenAddress?: string
  apiBase?: string
}): string {
  const root = (input.apiBase ?? "https://api.fomoapi.io").replace(/^http/, "ws").replace(/\/$/, "")
  const params = new URLSearchParams({
    chain: "solana",
    type: "thesis",
    key: input.apiKey.trim(),
  })
  if (input.tokenAddress?.trim()) {
    params.set("token", input.tokenAddress.trim())
  }
  return `${root}/ws/alerts?${params.toString()}`
}

export function fomoApiUserUrl(handle: string, apiBase?: string): string {
  const root = (apiBase ?? "https://api.fomoapi.io").replace(/\/$/, "")
  const clean = handle.replace(/^@/, "").trim()
  return `${root}/v2/users/${encodeURIComponent(clean)}`
}

export function parseFomoApiSolanaWallet(payload: unknown): string | null {
  const root = asRecord(payload)
  if (!root) return null
  const wallets = asRecord(root.wallets)
  const sol =
    asString(wallets?.solana) ??
    asString(wallets?.sol) ??
    asString(root.solanaWallet) ??
    asString(root.walletAddress)
  if (!sol || !isValidWallet(sol)) return null
  return sol
}

export async function resolveFomoSolanaWallet(input: {
  handle: string
  userId?: string | null
  apiKey: string
  apiBase?: string
  fetchImpl?: typeof fetch
}): Promise<string | null> {
  const fetchImpl = input.fetchImpl ?? fetch
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${input.apiKey}`,
    "User-Agent": "callout-snap/0.1",
  }

  const response = await fetchImpl(fomoApiUserUrl(input.handle, input.apiBase), {
    headers,
    cache: "no-store",
  })
  if (response.status === 404) return null
  if (response.status === 402) {
    throw new Error("fomoapi credits exhausted")
  }
  if (!response.ok) {
    throw new Error(`fomoapi HTTP ${response.status}`)
  }
  return parseFomoApiSolanaWallet(await response.json())
}

/**
 * Open the unmetered FOMO app feed, drain replay theses for one mint, then close.
 * This is what the FOMO app shows — not Axiom's incomplete mirror.
 */
export async function drainFomoThesisAlerts(input: {
  apiKey: string
  tokenAddress: string
  apiBase?: string
  /** Max time to collect replay + live (ms). */
  timeoutMs?: number
  /** Quiet period after last alert before closing (ms). */
  quietMs?: number
  WebSocketImpl?: typeof WebSocket
}): Promise<FomoThesisRecord[]> {
  const WebSocketImpl = input.WebSocketImpl ?? WebSocket
  const timeoutMs = input.timeoutMs ?? 15_000
  const quietMs = input.quietMs ?? 2_500
  const idleMs = Math.min(timeoutMs, Math.max(quietMs * 2, 6_000))
    const url = fomoAlertsWsUrl({
      apiKey: input.apiKey,
      // Pass the token address so FOMO's server pre-filters; client also filters as a guard.
      tokenAddress: input.tokenAddress,
      apiBase: input.apiBase,
    })

  return new Promise((resolve, reject) => {
    const byId = new Map<string, FomoThesisRecord>()
    let settled = false
    let quietTimer: ReturnType<typeof setTimeout> | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let ws: WebSocket

    const finish = () => {
      if (settled) return
      settled = true
      if (quietTimer) clearTimeout(quietTimer)
      if (idleTimer) clearTimeout(idleTimer)
      clearTimeout(hardTimer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve(
        [...byId.values()].sort((a, b) => b.createdAtMs - a.createdAtMs),
      )
    }

    const bumpQuiet = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(finish, quietMs)
    }

    const hardTimer = setTimeout(finish, timeoutMs)
    idleTimer = setTimeout(finish, idleMs)

    try {
      ws = new WebSocketImpl(url)
    } catch (error) {
      clearTimeout(hardTimer)
      if (idleTimer) clearTimeout(idleTimer)
      reject(error)
      return
    }

    ws.onmessage = (event) => {
      let payload: unknown
      try {
        payload = JSON.parse(String(event.data))
      } catch {
        return
      }
      const row = asRecord(payload)
      if (!row) return
      if (asString(row.type) === "welcome" || asString(row.type) === "heartbeat") {
        return
      }
      if (asString(row.type) !== "alert") return

      // When the WS is already filtered by token, events may omit the tokenAddress field.
      // Parse without preferMint guard; the server-side filter is our primary defence.
      const parsed = parseFomoThesis(row, input.tokenAddress)
      if (parsed) {
        byId.set(parsed.thesisId, parsed)
      }
      bumpQuiet()
    }

    ws.onerror = () => {
      if (!settled && byId.size === 0) {
        settled = true
        clearTimeout(hardTimer)
        if (quietTimer) clearTimeout(quietTimer)
        reject(new Error("FOMO alerts WebSocket failed"))
      } else {
        finish()
      }
    }

    ws.onclose = () => finish()
  })
}
