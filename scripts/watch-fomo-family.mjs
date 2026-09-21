#!/usr/bin/env node
/**
 * Always-on FOMO Family watcher → SHILL ingest.
 *
 * Auth: FOMO_FAMILY_PRIVY_TOKEN (Privy JWT from fomo.family localStorage privy:token)
 *   or FOMO_FAMILY_AUTHORIZATION / FOMO_FAMILY_COOKIE
 *
 *   node --env-file=.env.local scripts/watch-fomo-family.mjs
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

function loadEnvFile() {
  const path = resolve(process.cwd(), ".env.local")
  if (!existsSync(path)) return
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const i = trimmed.indexOf("=")
    if (i < 0) continue
    const key = trimmed.slice(0, i).trim()
    let val = trimmed.slice(i + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

loadEnvFile()

/** Session file written from Cursor browser (gitignored). */
function loadSessionFile() {
  const path = resolve(process.cwd(), ".fomo-session.json")
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function saveSessionFile(session) {
  const path = resolve(process.cwd(), ".fomo-session.json")
  writeFileSync(path, JSON.stringify({ ...session, updatedAt: new Date().toISOString() }, null, 2))
}

const session = loadSessionFile() || {}
if (session.privyToken && !process.env.FOMO_FAMILY_PRIVY_TOKEN) {
  process.env.FOMO_FAMILY_PRIVY_TOKEN = session.privyToken
}
if (session.refreshToken && !process.env.FOMO_FAMILY_REFRESH_TOKEN) {
  process.env.FOMO_FAMILY_REFRESH_TOKEN = session.refreshToken
}
if (session.mint && !process.env.FOMO_WATCH_MINT && !process.env.CALLOUT_MINT) {
  process.env.FOMO_WATCH_MINT = session.mint
}

const MINT = (process.env.CALLOUT_MINT || process.env.FOMO_WATCH_MINT || "").trim()
const INGEST =
  process.env.CALLOUT_INGEST_URL?.trim() ||
  "https://callout-beta.vercel.app/api/ingest/callout"
const ADMIN = process.env.ADMIN_KEY?.trim() || ""
const API_BASE = (process.env.FOMO_FAMILY_API_BASE || "https://prod-api.fomo.family").replace(
  /\/$/,
  "",
)
const POLL_MS = Math.max(15_000, Number(process.env.FOMO_FAMILY_POLL_MS || 30_000))
const NETWORK_ID = process.env.FOMO_FAMILY_NETWORK_ID?.trim() || "1399811149"

const seenComments = new Set()
const tradeCache = new Map() // tradeId -> { wallet, handle, commentId }
const handleByUserId = new Map()
const walletByHandle = new Map()

for (const part of (process.env.FOMO_WALLET_MAP || "").split(/[,;\n]+/)) {
  const [h, w] = part.split(":").map((s) => s?.trim())
  if (h && w) walletByHandle.set(h.replace(/^@/, "").toLowerCase(), w)
}

function privyToken() {
  return (
    process.env.FOMO_FAMILY_PRIVY_TOKEN?.trim() ||
    process.env.FOMO_FAMILY_AUTHORIZATION?.replace(/^Bearer\s+/i, "").trim() ||
    ""
  )
}

function tokenExpMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

async function ensureFreshPrivyToken() {
  const token = privyToken()
  const exp = tokenExpMs(token)
  const skew = 120_000
  if (token && exp > Date.now() + skew) return token

  const refresh =
    process.env.FOMO_FAMILY_REFRESH_TOKEN?.trim() ||
    loadSessionFile()?.refreshToken ||
    ""
  const appId =
    process.env.FOMO_FAMILY_PRIVY_APP_ID?.trim() ||
    loadSessionFile()?.appId ||
    "cm6h485o300n3zj9yl6vpedq7"
  if (!refresh) {
    throw new Error("Privy token expired — re-login in Cursor FOMO tab and re-run session capture")
  }

  const res = await fetch("https://auth.privy.io/api/v1/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "privy-app-id": appId,
    },
    body: JSON.stringify({ refresh_token: refresh }),
  })
  const json = await res.json().catch(() => ({}))
  const access = json.token || json.access_token
  if (!res.ok || !access) {
    throw new Error(`Privy refresh failed HTTP ${res.status}`)
  }
  const nextRefresh =
    typeof json.refresh_token === "string" &&
    json.refresh_token &&
    json.refresh_token !== "deprecated"
      ? json.refresh_token
      : refresh
  process.env.FOMO_FAMILY_PRIVY_TOKEN = access
  process.env.FOMO_FAMILY_REFRESH_TOKEN = nextRefresh
  saveSessionFile({
    ...(loadSessionFile() || {}),
    privyToken: access,
    refreshToken: nextRefresh,
    mint: MINT,
    appId,
  })
  console.log("[auth] Privy token refreshed")
  return access
}

function authHeaders() {
  const headers = {
    Accept: "application/json",
    Origin: "https://fomo.family",
    Referer: `https://fomo.family/tokens/solana/${MINT}`,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  }
  const cookie = process.env.FOMO_FAMILY_COOKIE?.trim()
  const token = privyToken()
  const auth = process.env.FOMO_FAMILY_AUTHORIZATION?.trim()
  if (cookie) headers.Cookie = cookie
  if (auth?.toLowerCase().startsWith("bearer ")) headers.Authorization = auth
  else if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function apiGet(url) {
  const res = await fetch(url, { headers: authHeaders(), cache: "no-store" })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* plain */
  }
  return { res, text, json }
}

function extractTrades(payload) {
  const trades = []
  const walk = (node) => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const id = typeof node.id === "string" ? node.id : null
    const tokenAddress = typeof node.tokenAddress === "string" ? node.tokenAddress : null
    if (
      id &&
      (tokenAddress === MINT || !tokenAddress) &&
      (node.userId || node.userAddress || node.commentId || node.humanTokenAmount != null)
    ) {
      trades.push({
        id,
        userId: node.userId || null,
        userAddress: node.userAddress || null,
        handle: node.username || node.handle || node.userHandle || null,
        commentId: node.commentId || null,
        tokenAddress: tokenAddress || MINT,
      })
    }
    for (const v of Object.values(node)) walk(v)
  }
  walk(payload)
  const byId = new Map()
  for (const t of trades) if (!byId.has(t.id)) byId.set(t.id, t)
  return [...byId.values()]
}

function parseComments(payload) {
  const root = payload?.responseObject ?? payload
  const list = root?.comments ?? payload?.comments ?? []
  if (!Array.isArray(list)) return []
  return list
    .filter((c) => c && !c.parentId && (!c.tokenAddress || c.tokenAddress === MINT))
    .map((c) => ({
      id: c.id,
      userId: c.userId,
      tradeId: c.tradeId,
      thesis: c.comment || c.commentSegments?.[0]?.text || "",
      createdAt: c.createdAt,
      handle: c.username || c.handle || c.userHandle || null,
    }))
}

async function loadTrade(tradeId) {
  if (tradeCache.has(tradeId)) return tradeCache.get(tradeId)
  const { res, json } = await apiGet(`${API_BASE}/trades/${encodeURIComponent(tradeId)}`)
  if (!res.ok) {
    tradeCache.set(tradeId, null)
    return null
  }
  const trade = json?.responseObject?.trade ?? json?.trade ?? json?.responseObject ?? json
  const info = {
    wallet: trade?.userAddress || null,
    handle: trade?.username || trade?.handle || trade?.userHandle || null,
    userId: trade?.userId || null,
    commentId: trade?.commentId || null,
  }
  tradeCache.set(tradeId, info)
  if (info.handle && info.wallet) {
    walletByHandle.set(String(info.handle).replace(/^@/, "").toLowerCase(), info.wallet)
  }
  return info
}

async function resolveHandle(userId) {
  if (!userId) return null
  if (handleByUserId.has(userId)) return handleByUserId.get(userId)
  const url = `${API_BASE}/users/${encodeURIComponent(userId)}`
  const { res, json } = await apiGet(url)
  if (!res.ok) return null
  const obj = json?.responseObject ?? json
  const handle = obj?.username || obj?.handle || obj?.userHandle || obj?.displayName || null
  if (handle) handleByUserId.set(userId, String(handle).replace(/^@/, ""))
  return handleByUserId.get(userId) ?? null
}

async function ingest(row, handle, wallet) {
  const res = await fetch(INGEST, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": ADMIN,
    },
    body: JSON.stringify({
      callerUsername: handle,
      wallet,
      source: "fomo",
      thesis: row.thesis,
      id: `fomo_family_${row.id}`,
      capturedAt: row.createdAt,
    }),
  })
  const text = await res.text()
  console.log(`[ingest ${res.status}] @${handle} “${row.thesis.slice(0, 60)}”`)
  if (!res.ok && res.status !== 409) console.warn(text.slice(0, 200))
}

async function fetchTradeList() {
  const urls = [
    process.env.FOMO_FAMILY_TRADES_URL?.trim(),
    `${API_BASE}/token/${encodeURIComponent(MINT)}/trades`,
    `${API_BASE}/networks/${NETWORK_ID}/tokens/${encodeURIComponent(MINT)}/trades`,
  ].filter(Boolean)

  for (const url of urls) {
    const { res, json, text } = await apiGet(url)
    if (res.status === 429) {
      console.warn("[trades] rate limited — backing off 60s")
      await sleep(60_000)
      continue
    }
    if (!res.ok) {
      console.warn(`[trades] ${res.status} ${url}`)
      continue
    }
    const trades = extractTrades(json ?? text)
    if (trades.length) return trades
  }
  return []
}

async function pollOnce() {
  if (!MINT) throw new Error("Set CALLOUT_MINT or FOMO_WATCH_MINT")
  if (!ADMIN) throw new Error("Set ADMIN_KEY")
  await ensureFreshPrivyToken()

  const trades = await fetchTradeList()
  console.log(`[poll] mint=${MINT.slice(0, 8)}… trades=${trades.length}`)

  // Prefer trades that already expose a thesis/comment id; still scan a few others.
  const prioritized = [
    ...trades.filter((t) => t.commentId),
    ...trades.filter((t) => !t.commentId),
  ].slice(0, 25)

  for (const t of prioritized) {
    await sleep(400) // be gentle with Cloudflare
    const detail = (await loadTrade(t.id)) || {}
    const { res, json } = await apiGet(`${API_BASE}/trades/${encodeURIComponent(t.id)}/comments`)
    if (res.status === 429) {
      console.warn("[comments] rate limited — backing off 60s")
      await sleep(60_000)
      continue
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`auth failed (${res.status}) — refresh FOMO_FAMILY_PRIVY_TOKEN`)
    }
    if (!res.ok) continue

    const comments = parseComments(json)
    for (const row of comments) {
      if (seenComments.has(row.id)) continue
      seenComments.add(row.id)

      const handle =
        row.handle ||
        detail.handle ||
        t.handle ||
        (await resolveHandle(row.userId || detail.userId || t.userId)) ||
        "fomo_user"
      const wallet =
        detail.wallet ||
        t.userAddress ||
        walletByHandle.get(handle.toLowerCase()) ||
        ""
      if (!wallet) {
        console.warn(`[skip] no wallet for @${handle} trade=${t.id}`)
        continue
      }
      await ingest(row, handle.replace(/^@/, ""), wallet)
    }
  }
}

async function main() {
  console.log(`[fomo-family] always-on every ${POLL_MS}ms → ${INGEST}`)
  console.log(`[fomo-family] mint=${MINT || "(missing)"} auth=${privyToken() ? "privy" : "none"}`)
  for (;;) {
    try {
      await pollOnce()
    } catch (error) {
      console.error("[fomo-family]", error instanceof Error ? error.message : error)
    }
    await sleep(POLL_MS)
  }
}

main()
