#!/usr/bin/env node
/**
 * Always-on FOMO Family watcher via Playwright (bypasses Node CF 430).
 * Polls FOMO from a real page context; POSTs callouts to SHILL ingest from Node.
 *
 *   node --env-file=.env.local scripts/watch-fomo-browser.mjs
 *
 * Auth: .fomo-session.json (privyToken + refreshToken) written from the FOMO tab.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"

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
  writeFileSync(
    path,
    JSON.stringify({ ...session, updatedAt: new Date().toISOString() }, null, 2),
  )
}

const session = loadSessionFile() || {}
if (session.privyToken && !process.env.FOMO_FAMILY_PRIVY_TOKEN) {
  process.env.FOMO_FAMILY_PRIVY_TOKEN = session.privyToken
}
if (session.refreshToken && !process.env.FOMO_FAMILY_REFRESH_TOKEN) {
  process.env.FOMO_FAMILY_REFRESH_TOKEN = session.refreshToken
}

const MINT = (
  process.env.CALLOUT_MINT ||
  process.env.FOMO_WATCH_MINT ||
  session.mint ||
  ""
).trim()
const INGEST =
  process.env.CALLOUT_INGEST_URL?.trim() ||
  "https://callout-beta.vercel.app/api/ingest/callout"
const ADMIN = process.env.ADMIN_KEY?.trim() || ""
const API_BASE = (process.env.FOMO_FAMILY_API_BASE || "https://prod-api.fomo.family").replace(
  /\/$/,
  "",
)
const POLL_MS = Math.max(15_000, Number(process.env.FOMO_FAMILY_POLL_MS || 20_000))
const NETWORK_ID = process.env.FOMO_FAMILY_NETWORK_ID?.trim() || "1399811149"
const APP_ID =
  process.env.FOMO_FAMILY_PRIVY_APP_ID?.trim() || session.appId || "cm6h485o300n3zj9yl6vpedq7"
const HEADLESS = process.env.FOMO_WATCH_HEADLESS === "1"

const seenComments = new Set()
const tradeCache = new Map()
let authBackoffMs = 0
let authBackoffUntil = 0

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function tokenExpMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

async function ensureFreshPrivyToken(page = null) {
  if (Date.now() < authBackoffUntil) {
    throw new Error(
      `Privy auth backing off ${Math.ceil((authBackoffUntil - Date.now()) / 1000)}s — re-login on FOMO`,
    )
  }

  let token = process.env.FOMO_FAMILY_PRIVY_TOKEN?.trim() || ""
  const exp = tokenExpMs(token)
  if (token && exp > Date.now() + 120_000) {
    authBackoffMs = 0
    return token
  }

  // Prefer a session file that may have been refreshed from the browser tab.
  const disk = loadSessionFile()
  if (disk?.privyToken && tokenExpMs(disk.privyToken) > Date.now() + 120_000) {
    process.env.FOMO_FAMILY_PRIVY_TOKEN = disk.privyToken
    if (disk.refreshToken) process.env.FOMO_FAMILY_REFRESH_TOKEN = disk.refreshToken
    authBackoffMs = 0
    return disk.privyToken
  }

  const refresh =
    process.env.FOMO_FAMILY_REFRESH_TOKEN?.trim() || disk?.refreshToken || ""
  if (!refresh || refresh === "deprecated") {
    throw new Error("Privy token expired — re-login on FOMO and refresh .fomo-session.json")
  }

  // Node → Privy is CF-blocked (403). Refresh inside the FOMO page context instead.
  if (!page) {
    throw new Error("Privy token expired — need Playwright page to refresh via /api/v1/sessions")
  }

  const result = await page.evaluate(
    async ({ appId, refreshToken }) => {
      const r = await fetch("https://auth.privy.io/api/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "privy-app-id": appId },
        credentials: "include",
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      const json = await r.json().catch(() => ({}))
      return {
        ok: r.ok,
        status: r.status,
        access: json.token || json.access_token || null,
        refresh:
          typeof json.refresh_token === "string" &&
          json.refresh_token &&
          json.refresh_token !== "deprecated"
            ? json.refresh_token
            : refreshToken,
      }
    },
    { appId: APP_ID, refreshToken: refresh },
  )

  if (!result.ok || !result.access) {
    authBackoffMs = Math.min(15 * 60_000, Math.max(60_000, (authBackoffMs || 30_000) * 2))
    authBackoffUntil = Date.now() + authBackoffMs
    throw new Error(
      `Privy refresh failed HTTP ${result.status} — backing off ${Math.round(authBackoffMs / 1000)}s`,
    )
  }

  process.env.FOMO_FAMILY_PRIVY_TOKEN = result.access
  process.env.FOMO_FAMILY_REFRESH_TOKEN = result.refresh
  saveSessionFile({
    ...(loadSessionFile() || {}),
    privyToken: result.access,
    refreshToken: result.refresh,
    mint: MINT,
    appId: APP_ID,
  })
  authBackoffMs = 0
  authBackoffUntil = 0
  console.log("[auth] Privy token refreshed (page)")
  return result.access
}

async function fetchLastSnapshotAt() {
  try {
    const res = await fetch(`${INGEST.replace(/\/api\/ingest\/callout$/, "")}/api/public/state`, {
      headers: { "Cache-Control": "no-store" },
    })
    if (!res.ok) return null
    const json = await res.json()
    const at = json?.engine?.lastSnapshotAt
    return typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null
  } catch {
    return null
  }
}

async function ingest(row, handle, wallet, lastSnapshotAt) {
  const capturedAt = row.createdAt || new Date().toISOString()
  // Already settled in a prior snapshot — do not re-queue into the live window.
  if (lastSnapshotAt && Number.isFinite(Date.parse(capturedAt)) && Date.parse(capturedAt) <= Date.parse(lastSnapshotAt)) {
    console.log(`[skip] already settled @${handle} id=${row.id}`)
    return "skip"
  }
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
      capturedAt,
    }),
  })
  const text = await res.text()
  console.log(`[ingest ${res.status}] @${handle} “${(row.thesis || "").slice(0, 60)}”`)
  if (!res.ok && res.status !== 409) console.warn(text.slice(0, 200))
  return res.status
}

async function pageApiGet(page, url) {
  return page.evaluate(async (u) => {
    const token = (localStorage.getItem("privy:token") || "").replace(/^"|"$/g, "")
    const r = await fetch(u, {
      headers: {
        Accept: "application/json",
        Authorization: token ? `Bearer ${token}` : "",
        Origin: location.origin,
        Referer: location.href,
      },
      credentials: "include",
    })
    const text = await r.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* plain */
    }
    return { ok: r.ok, status: r.status, text: text.slice(0, 400), json }
  }, url)
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
    if (
      id &&
      (node.userId || node.userAddress || node.commentId || node.humanTokenAmount != null)
    ) {
      trades.push({
        id,
        userId: node.userId || null,
        userAddress: node.userAddress || null,
        handle: node.username || node.handle || node.userHandle || null,
        commentId: node.commentId || null,
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
    .filter((c) => c && !c.parentId)
    .map((c) => ({
      id: c.id,
      userId: c.userId,
      tradeId: c.tradeId,
      thesis: c.comment || c.commentSegments?.[0]?.text || "",
      createdAt: c.createdAt,
      handle: c.username || c.handle || c.userHandle || null,
    }))
}

function thesisText(value) {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (!value || typeof value !== "object") return ""
  if (typeof value.text === "string" && value.text.trim()) return value.text.trim()
  if (typeof value.comment === "string" && value.comment.trim()) return value.comment.trim()
  if (typeof value.body === "string" && value.body.trim()) return value.body.trim()
  if (typeof value.thesis === "string" && value.thesis.trim()) return value.thesis.trim()
  const seg = Array.isArray(value.commentSegments) ? value.commentSegments[0] : null
  if (seg && typeof seg.text === "string" && seg.text.trim()) return seg.text.trim()
  return ""
}

function parseThesisFeed(payload) {
  const root = payload?.responseObject ?? payload
  const list = root?.theses ?? root?.items ?? root?.feed ?? root?.data ?? payload?.theses ?? []
  if (!Array.isArray(list)) return []
  const out = []
  for (const node of list) {
    if (!node || typeof node !== "object") continue
    const id =
      (typeof node.id === "string" && node.id) ||
      (typeof node.commentId === "string" && node.commentId) ||
      (typeof node.thesisId === "string" && node.thesisId) ||
      null
    if (!id) continue
    const thesis =
      thesisText(node.comment) ||
      thesisText(node.thesis) ||
      thesisText(node.text) ||
      thesisText(node)
    if (!thesis) continue
    const user = node.user && typeof node.user === "object" ? node.user : null
    out.push({
      id,
      thesis,
      createdAt: node.createdAt || node.timestamp || null,
      handle:
        node.username ||
        node.handle ||
        node.userHandle ||
        user?.username ||
        user?.handle ||
        null,
      wallet: node.userAddress || node.wallet || user?.address || user?.userAddress || null,
      tradeId: node.tradeId || null,
      userId: node.userId || user?.id || null,
    })
  }
  const byId = new Map()
  for (const t of out) if (!byId.has(t.id)) byId.set(t.id, t)
  return [...byId.values()]
}

async function loadTrade(page, tradeId) {
  if (tradeCache.has(tradeId)) return tradeCache.get(tradeId)
  const { ok, json } = await pageApiGet(page, `${API_BASE}/trades/${encodeURIComponent(tradeId)}`)
  if (!ok) {
    tradeCache.set(tradeId, null)
    return null
  }
  const trade = json?.responseObject?.trade ?? json?.trade ?? {}
  const info = {
    wallet: trade.userAddress || null,
    handle: trade.username || trade.handle || null,
    commentId: trade.commentId || null,
  }
  tradeCache.set(tradeId, info)
  return info
}

async function syncTokenToPage(page, token) {
  await page.evaluate((t) => {
    localStorage.setItem("privy:token", JSON.stringify(t))
  }, token)
}

async function pollOnce(page) {
  const token = await ensureFreshPrivyToken(page)
  await syncTokenToPage(page, token)
  const lastSnapshotAt = await fetchLastSnapshotAt()

  // Prefer thesis feed; fall back to trades→comments.
  const feedUrl =
    `${API_BASE}/feed/token/thesis?tokenAddress=${encodeURIComponent(MINT)}` +
    `&networkId=${NETWORK_ID}&limit=30&threshold=0`
  const feed = await pageApiGet(page, feedUrl)
  let accepted = 0

  if (feed.ok) {
    const theses = parseThesisFeed(feed.json)
    console.log(`[poll] thesis feed=${theses.length}`)
    for (const row of theses) {
      if (seenComments.has(row.id)) continue
      seenComments.add(row.id)
      let wallet = row.wallet || ""
      let handle = (row.handle || "fomo_user").replace(/^@/, "")
      if ((!wallet || handle === "fomo_user") && row.tradeId) {
        const detail = await loadTrade(page, row.tradeId)
        wallet = wallet || detail?.wallet || ""
        handle = handle !== "fomo_user" ? handle : (detail?.handle || handle).replace(/^@/, "")
      }
      if (!wallet) {
        console.warn(`[skip] no wallet @${handle} id=${row.id}`)
        continue
      }
      const status = await ingest(row, handle, wallet, lastSnapshotAt)
      if (status === 200 || status === 409) accepted += 1
      await sleep(200)
    }
    return accepted
  }

  console.warn(`[poll] thesis feed ${feed.status} — falling back to trades/comments`)
  const tradeUrls = [
    `${API_BASE}/token/${encodeURIComponent(MINT)}/trades`,
    `${API_BASE}/networks/${NETWORK_ID}/tokens/${encodeURIComponent(MINT)}/trades`,
  ]
  let trades = []
  for (const url of tradeUrls) {
    const { ok, status, json } = await pageApiGet(page, url)
    if (status === 429) {
      console.warn("[trades] rate limited — backing off 60s")
      await sleep(60_000)
      continue
    }
    if (!ok) {
      console.warn(`[trades] ${status} ${url}`)
      continue
    }
    trades = extractTrades(json)
    if (trades.length) break
  }
  console.log(`[poll] trades=${trades.length}`)
  const prioritized = [
    ...trades.filter((t) => t.commentId),
    ...trades.filter((t) => !t.commentId),
  ].slice(0, 25)

  for (const t of prioritized) {
    await sleep(350)
    const detail = (await loadTrade(page, t.id)) || {}
    const { ok, status, json } = await pageApiGet(
      page,
      `${API_BASE}/trades/${encodeURIComponent(t.id)}/comments`,
    )
    if (status === 429) {
      console.warn("[comments] rate limited — backing off 60s")
      await sleep(60_000)
      continue
    }
    if (!ok) continue
    for (const row of parseComments(json)) {
      if (seenComments.has(row.id)) continue
      seenComments.add(row.id)
      const handle = (row.handle || detail.handle || t.handle || "fomo_user").replace(/^@/, "")
      const wallet = detail.wallet || t.userAddress || ""
      if (!wallet) {
        console.warn(`[skip] no wallet @${handle}`)
        continue
      }
      const st = await ingest(row, handle, wallet, lastSnapshotAt)
      if (st === 200 || st === 409) accepted += 1
    }
  }
  return accepted
}

async function main() {
  if (!MINT) throw new Error("Set CALLOUT_MINT / FOMO_WATCH_MINT or session.mint")
  if (!ADMIN) throw new Error("Set ADMIN_KEY")

  // Bootstrap with whatever token we have (may be near expiry); page refresh handles renewals.
  let token =
    process.env.FOMO_FAMILY_PRIVY_TOKEN?.trim() ||
    loadSessionFile()?.privyToken ||
    ""
  if (!token) throw new Error("Missing FOMO_FAMILY_PRIVY_TOKEN / .fomo-session.json")
  process.env.FOMO_FAMILY_PRIVY_TOKEN = token
  if (!process.env.FOMO_FAMILY_REFRESH_TOKEN) {
    const disk = loadSessionFile()
    if (disk?.refreshToken) process.env.FOMO_FAMILY_REFRESH_TOKEN = disk.refreshToken
  }

  const tokenPage = `https://fomo.family/tokens/solana/${MINT}`

  console.log(`[fomo-browser] always-on every ${POLL_MS}ms → ${INGEST}`)
  console.log(`[fomo-browser] mint=${MINT.slice(0, 8)}… headless=${HEADLESS}`)

  // Prefer installed Chrome (no playwright browser download). Override with FOMO_WATCH_CHANNEL.
  const channel = process.env.FOMO_WATCH_CHANNEL || "chrome"
  const browser = await chromium.launch({
    headless: HEADLESS,
    channel,
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  })
  await context.addInitScript(
    ({ accessToken, refreshToken }) => {
      try {
        localStorage.setItem("privy:token", JSON.stringify(accessToken))
        if (refreshToken) localStorage.setItem("privy:refresh_token", JSON.stringify(refreshToken))
      } catch {
        /* ignore */
      }
    },
    {
      accessToken: token,
      refreshToken: process.env.FOMO_FAMILY_REFRESH_TOKEN || "",
    },
  )

  const page = await context.newPage()
  await page.goto(tokenPage, { waitUntil: "domcontentloaded", timeout: 90_000 })
  console.log(`[fomo-browser] opened ${tokenPage}`)

  // Renew immediately if bootstrap token is stale (page-context Privy call).
  try {
    token = await ensureFreshPrivyToken(page)
    await syncTokenToPage(page, token)
  } catch (error) {
    console.warn("[fomo-browser]", error instanceof Error ? error.message : error)
  }

  // Smoke-test page-context API access
  const smoke = await pageApiGet(page, `${API_BASE}/token/${encodeURIComponent(MINT)}/trades`)
  console.log(`[fomo-browser] smoke trades HTTP ${smoke.status}`)
  if (smoke.status === 430 || smoke.status === 401 || smoke.status === 403) {
    console.warn(
      "[fomo-browser] auth/CF blocked inside Playwright — keep the Cursor FOMO tab logged in and re-capture session",
    )
  }

  for (;;) {
    try {
      const n = await pollOnce(page)
      if (n) console.log(`[fomo-browser] accepted/dup ${n}`)
    } catch (error) {
      console.error("[fomo-browser]", error instanceof Error ? error.message : error)
    }
    await sleep(POLL_MS)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
