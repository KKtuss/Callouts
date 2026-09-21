import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { gunzipSync, gzipSync } from "node:zlib"
import path from "node:path"
import { isMintAddress } from "@/lib/coin"
import { explorerTxUrl } from "@/lib/explorer"
import { deleteWatch, loadWatch, saveWatch } from "@/engine/watch-kv"
import type { Callout, DistributionTx, SnapshotAudit, TxStatus } from "@/engine/types"

export type PersistedPayout = {
  u: string
  w: string
  th?: string
  /** Callout source: fomo | pump-fun | axiom | … */
  s?: string
  sig?: string | null
  st?: string
}

export type PersistedRound = {
  id: string
  at: string
  n: number
  s: SnapshotAudit["confirmationStatus"]
  a: number
  tok: string
  skip?: string | null
  L?: PersistedPayout
  R?: PersistedPayout
}

export type PersistedCaller = {
  i: string
  u: string
  w: string
  t: string
  s?: string
}

export type PersistedWatch = {
  mint: string
  ticker: string
  name: string | null
  qualifiedTelegramId?: number | null
  qualifiedFingerprint?: string | null
  lastSnapshotAt?: string | null
  nextSnapshotAt?: string | null
  schedulerPaused?: boolean
  rounds?: PersistedRound[]
  migrationPaid?: boolean
  /** Current snapshot window only (QUALIFIED board hydrate). */
  callouts?: PersistedCaller[]
  /** Accepted callouts since this mint watch started — bonding eligibility. */
  lifetimeCallouts?: PersistedCaller[]
}

const MAX_PERSISTED_ROUNDS = 50
const MAX_WINDOW_CALLOUTS = 80
const MAX_LIFETIME_CALLOUTS = 2_000

export type PinBoardRef = {
  qualifiedTelegramId: number | null
  qualifiedTelegramIds: number[]
  qualifiedFingerprintHash: string | null
  qualifiedCount: number | null
  lastSnapshotAt: string | null
  nextSnapshotAt: string | null
  snapshotClaimId: string | null
  schedulerPaused: boolean | null
  rounds: PersistedRound[]
  migrationPaid: boolean | null
  callouts: PersistedCaller[]
}

const PIN_CALLOUTS_MAX_CHARS = 1400

function watchFile(): string {
  if (process.env.VERCEL) return "/tmp/callout-watch.json"
  return path.join(process.cwd(), ".data", "watch.json")
}

function persistEnabled() {
  // Vitest opts out of disk/Redis unless a suite opts in for durable-watch tests.
  if (process.env.VITEST === "true" && process.env.CALLOUT_PERSIST_TEST !== "true") return false
  return true
}

function normalizeWatch(parsed: Partial<PersistedWatch>): PersistedWatch | null {
  const mint = typeof parsed.mint === "string" ? parsed.mint.trim() : ""
  if (!isMintAddress(mint)) return null
  return {
    mint,
    ticker: typeof parsed.ticker === "string" && parsed.ticker.trim() ? parsed.ticker.trim() : "TOKEN",
    name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null,
    qualifiedTelegramId:
      typeof parsed.qualifiedTelegramId === "number" && parsed.qualifiedTelegramId > 0
        ? parsed.qualifiedTelegramId
        : null,
    qualifiedFingerprint:
      typeof parsed.qualifiedFingerprint === "string" && parsed.qualifiedFingerprint
        ? parsed.qualifiedFingerprint
        : null,
    lastSnapshotAt:
      typeof parsed.lastSnapshotAt === "string" && Number.isFinite(Date.parse(parsed.lastSnapshotAt))
        ? parsed.lastSnapshotAt
        : null,
    nextSnapshotAt:
      typeof parsed.nextSnapshotAt === "string" && Number.isFinite(Date.parse(parsed.nextSnapshotAt))
        ? parsed.nextSnapshotAt
        : null,
    schedulerPaused: parsed.schedulerPaused === true,
    rounds: sanitizeRounds(parsed.rounds),
    migrationPaid: parsed.migrationPaid === true,
    callouts: sanitizeCallers(parsed.callouts, MAX_WINDOW_CALLOUTS),
    lifetimeCallouts: sanitizeCallers(parsed.lifetimeCallouts, MAX_LIFETIME_CALLOUTS),
  }
}

function readWatchFile(): PersistedWatch | null {
  if (!persistEnabled()) return null
  try {
    const file = watchFile()
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedWatch>
    return normalizeWatch(parsed)
  } catch {
    return null
  }
}

/** Sync file read (tests / local). Prefer `loadPersistedWatch` when Redis may hold truth. */
export function readPersistedWatch(): PersistedWatch | null {
  return readWatchFile()
}

/**
 * Redis-first load for the active mint, falling back to the local watch file.
 * Pass `preferredMint` so cold isolates can fetch the durable key without a local file.
 */
export async function loadPersistedWatch(
  preferredMint?: string | null,
): Promise<PersistedWatch | null> {
  if (!persistEnabled()) return null
  const mint = preferredMint?.trim() || readWatchFile()?.mint || null
  if (mint) {
    const fromKv = await loadWatch(mint)
    const normalized = fromKv ? normalizeWatch(fromKv) : null
    if (normalized) {
      writeWatchFile(normalized)
      return normalized
    }
  }
  return readWatchFile()
}

/** Exported for unit tests — merges a watch patch onto durable Redis/file state. */
export function mergePersistedWatch(
  watch: PersistedWatch,
  previous: PersistedWatch | null,
): PersistedWatch {
  return mergeWatch(watch, previous)
}

function mergeWatch(watch: PersistedWatch, previous: PersistedWatch | null): PersistedWatch {
  const sameMint = previous?.mint === watch.mint
  return {
    mint: watch.mint,
    ticker: watch.ticker,
    name: watch.name,
    qualifiedTelegramId: Object.prototype.hasOwnProperty.call(watch, "qualifiedTelegramId")
      ? watch.qualifiedTelegramId ?? null
      : sameMint
        ? previous?.qualifiedTelegramId ?? null
        : null,
    qualifiedFingerprint: Object.prototype.hasOwnProperty.call(watch, "qualifiedFingerprint")
      ? watch.qualifiedFingerprint ?? null
      : sameMint
        ? previous?.qualifiedFingerprint ?? null
        : null,
    lastSnapshotAt: Object.prototype.hasOwnProperty.call(watch, "lastSnapshotAt")
      ? watch.lastSnapshotAt ?? null
      : sameMint
        ? previous?.lastSnapshotAt ?? null
        : null,
    nextSnapshotAt: Object.prototype.hasOwnProperty.call(watch, "nextSnapshotAt")
      ? watch.nextSnapshotAt ?? null
      : sameMint
        ? previous?.nextSnapshotAt ?? null
        : null,
    schedulerPaused: Object.prototype.hasOwnProperty.call(watch, "schedulerPaused")
      ? Boolean(watch.schedulerPaused)
      : sameMint
        ? Boolean(previous?.schedulerPaused)
        : false,
    rounds: Object.prototype.hasOwnProperty.call(watch, "rounds")
      ? mergeRounds(sanitizeRounds(watch.rounds), sameMint ? previous?.rounds ?? [] : [])
      : sameMint
        ? previous?.rounds ?? []
        : [],
    migrationPaid: Object.prototype.hasOwnProperty.call(watch, "migrationPaid")
      ? Boolean(watch.migrationPaid)
      : sameMint
        ? Boolean(previous?.migrationPaid)
        : false,
    callouts: Object.prototype.hasOwnProperty.call(watch, "callouts")
      ? pruneCalloutsBeforeSnapshot(
          mergeLifetimeCallouts(
            sameMint ? previous?.callouts : undefined,
            sanitizeCallers(watch.callouts, MAX_WINDOW_CALLOUTS),
          ).slice(-MAX_WINDOW_CALLOUTS),
          Object.prototype.hasOwnProperty.call(watch, "lastSnapshotAt")
            ? watch.lastSnapshotAt
            : sameMint
              ? previous?.lastSnapshotAt
              : null,
        )
      : sameMint
        ? previous?.callouts ?? []
        : [],
    lifetimeCallouts: Object.prototype.hasOwnProperty.call(watch, "lifetimeCallouts")
      ? mergeLifetimeCallouts(
          sameMint ? previous?.lifetimeCallouts : undefined,
          sanitizeCallers(watch.lifetimeCallouts, MAX_LIFETIME_CALLOUTS),
        )
      : sameMint
        ? previous?.lifetimeCallouts ?? []
        : [],
  }
}

/** Drop window callouts that already fell behind the snapshot cursor. */
function pruneCalloutsBeforeSnapshot(
  rows: PersistedCaller[],
  lastSnapshotAt: string | null | undefined,
): PersistedCaller[] {
  if (!lastSnapshotAt || !Number.isFinite(Date.parse(lastSnapshotAt))) {
    return rows.slice(-MAX_WINDOW_CALLOUTS)
  }
  return rows
    .filter((row) => row.t > lastSnapshotAt)
    .slice(-MAX_WINDOW_CALLOUTS)
}

function writeWatchFile(next: PersistedWatch) {
  if (!persistEnabled()) return
  try {
    const file = watchFile()
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2))
  } catch (error) {
    console.warn("[watch] failed to persist mint", error)
  }
  process.env.CALLOUT_MINT = next.mint
  process.env.CALLOUT_TOKEN = next.ticker
  process.env.DISTRIBUTION_TOKEN = next.ticker
  if (next.name) process.env.CALLOUT_NAME = next.name
}

/** Sync write to the local file. Prefer `persistWatch` so Redis stays in sync. */
export function writePersistedWatch(watch: PersistedWatch) {
  if (!persistEnabled()) return
  if (!isMintAddress(watch.mint)) return
  const next = mergeWatch(watch, readWatchFile())
  writeWatchFile(next)
}

/** File + Redis write. Use on every durable ledger update. */
export async function persistWatch(watch: PersistedWatch): Promise<PersistedWatch | null> {
  if (!persistEnabled()) return null
  if (!isMintAddress(watch.mint)) return null
  const previous = (await loadPersistedWatch(watch.mint)) ?? readWatchFile()
  const next = mergeWatch(watch, previous?.mint === watch.mint ? previous : null)
  writeWatchFile(next)
  await saveWatch(next)
  return next
}

/**
 * Drop local file + Redis key so idle / mint-switch cannot revive prior rounds
 * or bonding counts.
 */
export async function clearPersistedWatch(mint?: string | null): Promise<void> {
  const known = mint?.trim() || readWatchFile()?.mint || process.env.CALLOUT_MINT?.trim() || null
  delete process.env.CALLOUT_MINT
  if (!persistEnabled()) {
    if (known) await deleteWatch(known)
    return
  }
  try {
    const file = watchFile()
    if (existsSync(file)) unlinkSync(file)
  } catch (error) {
    console.warn("[watch] failed to clear persisted mint", error)
  }
  if (known) await deleteWatch(known)
}

const MINT_IN_URL =
  /(?:pump\.fun\/(?:coin|token)\/|solscan\.io\/(?:account|token)\/)([1-9A-HJ-NP-Za-km-z]{32,44})/i
const PUMP_SUFFIX_MINT = /[1-9A-HJ-NP-Za-km-z]{32,44}pump/

export function parseMintsFromTelegramHtml(html: string | null | undefined): string[] {
  if (!html) return []
  const found: string[] = []
  const add = (value: string | undefined) => {
    const mint = value?.trim() ?? ""
    if (isMintAddress(mint) && !found.includes(mint)) found.push(mint)
  }
  const urlRe = new RegExp(MINT_IN_URL.source, "gi")
  for (const match of html.matchAll(urlRe)) add(match[1])
  const suffixRe = new RegExp(PUMP_SUFFIX_MINT.source, "g")
  for (const match of html.matchAll(suffixRe)) add(match[0])
  return found
}

export function parseMintFromTelegramHtml(html: string | null | undefined): string | null {
  return parseMintsFromTelegramHtml(html)[0] ?? null
}

export function preferMint(found: string[], preferred?: string | null): string | null {
  const want = preferred?.trim() || ""
  if (want && found.includes(want)) return want
  return found[0] ?? null
}

export function parseQualifiedBoardRef(text: string | null | undefined): PinBoardRef {
  const empty: PinBoardRef = {
    qualifiedTelegramId: null,
    qualifiedTelegramIds: [],
    qualifiedFingerprintHash: null,
    qualifiedCount: null,
    lastSnapshotAt: null,
    nextSnapshotAt: null,
    snapshotClaimId: null,
    schedulerPaused: null,
    rounds: [],
    migrationPaid: null,
    callouts: [],
  }
  if (!text) return empty
  const qids = parseQids(text.match(/[?#&]qid=([\d.]+)/i)?.[1] ?? null)
  const qfp = text.match(/[?#&]qfp=([0-9a-f]{8,})/i)?.[1] ?? null
  const qnRaw = Number(text.match(/[?#&]qn=(\d+)/i)?.[1] ?? "")
  const snap = text.match(/[?#&]snap=([^&#]+)/i)?.[1] ?? null
  const encoded = text.match(/[?#&]r=([A-Za-z0-9_-]+)/)?.[1] ?? null
  const packed = text.match(/[?#&]c=([A-Za-z0-9_-]+)/)?.[1] ?? null
  const nxt = text.match(/[?#&]nxt=(\d{10,13})/)?.[1] ?? null
  const sid = text.match(/[?#&]sid=([^&#]+)/i)?.[1] ?? null
  const pausedFlag = text.match(/[?#&]p=([01])/)?.[1] ?? null
  const migFlag = text.match(/[?#&]mig=([01])/)?.[1] ?? null
  const lastSnapshotAt = snap ? decodeURIComponent(snap) : null
  const snapshotClaimId = sid ? decodeURIComponent(sid) : null
  return {
    qualifiedTelegramId: qids[0] ?? null,
    qualifiedTelegramIds: qids,
    qualifiedFingerprintHash: qfp,
    qualifiedCount: Number.isFinite(qnRaw) && qnRaw > 0 ? qnRaw : null,
    lastSnapshotAt:
      lastSnapshotAt && Number.isFinite(Date.parse(lastSnapshotAt)) ? lastSnapshotAt : null,
    nextSnapshotAt: unixToIso(nxt),
    snapshotClaimId: snapshotClaimId || null,
    schedulerPaused: pausedFlag === "1" ? true : pausedFlag === "0" ? false : null,
    rounds: encoded ? decodeRounds(encoded) : [],
    migrationPaid: migFlag === "1" ? true : migFlag === "0" ? false : null,
    callouts: packed ? decodeCallouts(packed) : [],
  }
}

function parseQids(raw: string | null): number[] {
  if (!raw) return []
  const ids: number[] = []
  for (const part of raw.split(".")) {
    const id = Number(part)
    if (!Number.isFinite(id) || id <= 0 || ids.includes(id)) continue
    ids.push(id)
  }
  return ids.slice(0, 8)
}

function unixToIso(raw: string | null): string | null {
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return null
  const ms = raw.length > 10 ? value : value * 1000
  const iso = new Date(ms).toISOString()
  return Number.isFinite(Date.parse(iso)) ? iso : null
}

export function siteUrlWithBoardRef(
  siteUrl: string,
  ref: {
    qid?: number | null
    qids?: number[] | null
    qfp?: string | null
    qn?: number | null
    snap?: string | null
    rounds?: PersistedRound[]
    next?: string | null
    snapshotClaimId?: string | null
    paused?: boolean | null
    paid?: boolean | null
    callouts?: PersistedCaller[]
  },
): string {
  const url = siteUrl.split("#")[0]
  const qids = parseQids(
    [ref.qid, ...(ref.qids ?? [])]
      .filter((id): id is number => typeof id === "number" && id > 0)
      .join("."),
  )
  const qid = qids.length ? qids.join(".") : null
  const qfp = ref.qfp?.trim() || null
  const snap = ref.snap && Number.isFinite(Date.parse(ref.snap)) ? ref.snap : null
  let encoded = ref.rounds?.length ? encodeRounds(ref.rounds.slice(0, 1)) : null
  if (encoded && encoded.length > 900) encoded = null
  const packed = encodeCalloutsForPin(ref.callouts ?? [], PIN_CALLOUTS_MAX_CHARS)
  const nextMs = ref.next && Number.isFinite(Date.parse(ref.next)) ? Date.parse(ref.next) : NaN
  const nxt =
    ref.paused !== true && Number.isFinite(nextMs) && nextMs > Date.now()
      ? Math.floor(nextMs / 1000)
      : null
  const hash = [
    qid ? `qid=${qid}` : null,
    qfp ? `qfp=${qfp}` : null,
    ref.qn && ref.qn > 0 ? `qn=${Math.floor(ref.qn)}` : null,
    snap ? `snap=${encodeURIComponent(snap)}` : null,
    ref.snapshotClaimId ? `sid=${encodeURIComponent(ref.snapshotClaimId)}` : null,
    encoded ? `r=${encoded}` : null,
    packed ? `c=${packed}` : null,
    nxt ? `nxt=${nxt}` : null,
    ref.paused === true ? "p=1" : ref.paused === false ? "p=0" : null,
    ref.paid === true ? "mig=1" : null,
  ]
    .filter(Boolean)
    .join("&")
  return hash ? `${url}#${hash}` : url
}

type PinPayload = {
  caption?: string
  text?: string
  caption_entities?: Array<{ url?: string }>
  entities?: Array<{ url?: string }>
}

function pinBlobs(pin: PinPayload): string[] {
  return [
    pin.caption,
    pin.text,
    ...(pin.caption_entities ?? []).map((e) => e.url),
    ...(pin.entities ?? []).map((e) => e.url),
  ].filter((blob): blob is string => Boolean(blob))
}

let pinCache: { key: string; at: number; pin: PinPayload | null } | null = null

export function clearPinCache() {
  pinCache = null
}

async function fetchPinnedIntro(token: string, chatId: string): Promise<PinPayload | null> {
  const key = `${token}:${chatId}`
  if (pinCache && pinCache.key === key && Date.now() - pinCache.at < 1_000) {
    return pinCache.pin
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId }),
      signal: AbortSignal.timeout(8_000),
    })
    const payload = (await response.json()) as {
      ok?: boolean
      result?: { pinned_message?: PinPayload }
    }
    const pin = payload.ok ? payload.result?.pinned_message ?? null : null
    pinCache = { key, at: Date.now(), pin }
    return pin
  } catch {
    pinCache = { key, at: Date.now(), pin: null }
    return null
  }
}

export async function readMintFromPinnedIntro(
  token: string,
  chatId: string,
  preferredMint?: string | null,
): Promise<string | null> {
  const pin = await fetchPinnedIntro(token, chatId)
  if (!pin) return null
  const found: string[] = []
  for (const blob of pinBlobs(pin)) {
    for (const mint of parseMintsFromTelegramHtml(blob)) {
      if (!found.includes(mint)) found.push(mint)
    }
  }
  return preferMint(found, preferredMint ?? process.env.CALLOUT_MINT)
}

export async function readQualifiedBoardFromPin(
  token: string,
  chatId: string,
): Promise<PinBoardRef> {
  const merged: PinBoardRef = {
    qualifiedTelegramId: null,
    qualifiedTelegramIds: [],
    qualifiedFingerprintHash: null,
    qualifiedCount: null,
    lastSnapshotAt: null,
    nextSnapshotAt: null,
    snapshotClaimId: null,
    schedulerPaused: null,
    rounds: [],
    migrationPaid: null,
    callouts: [],
  }
  const pin = await fetchPinnedIntro(token, chatId)
  if (!pin) return merged
  for (const blob of pinBlobs(pin)) {
    const parsed = parseQualifiedBoardRef(blob)
    if (parsed.qualifiedTelegramIds.length) {
      const ids = parseQids([...merged.qualifiedTelegramIds, ...parsed.qualifiedTelegramIds].join("."))
      merged.qualifiedTelegramIds = ids
      merged.qualifiedTelegramId = ids[0] ?? merged.qualifiedTelegramId
    } else if (!merged.qualifiedTelegramId && parsed.qualifiedTelegramId) {
      merged.qualifiedTelegramId = parsed.qualifiedTelegramId
      merged.qualifiedTelegramIds = [parsed.qualifiedTelegramId]
    }
    if (!merged.qualifiedFingerprintHash && parsed.qualifiedFingerprintHash) {
      merged.qualifiedFingerprintHash = parsed.qualifiedFingerprintHash
    }
    if (
      parsed.qualifiedCount &&
      parsed.qualifiedCount > (merged.qualifiedCount ?? 0)
    ) {
      merged.qualifiedCount = parsed.qualifiedCount
    }
    if (!merged.lastSnapshotAt && parsed.lastSnapshotAt) {
      merged.lastSnapshotAt = parsed.lastSnapshotAt
    }
    if (!merged.nextSnapshotAt && parsed.nextSnapshotAt) {
      merged.nextSnapshotAt = parsed.nextSnapshotAt
    }
    if (!merged.snapshotClaimId && parsed.snapshotClaimId) {
      merged.snapshotClaimId = parsed.snapshotClaimId
    }
    if (merged.schedulerPaused === null && parsed.schedulerPaused !== null) {
      merged.schedulerPaused = parsed.schedulerPaused
    }
    if (!merged.rounds.length && parsed.rounds.length) {
      merged.rounds = parsed.rounds
    }
    if (merged.migrationPaid !== true && parsed.migrationPaid === true) {
      merged.migrationPaid = true
    }
    if (parsed.callouts.length > merged.callouts.length) {
      merged.callouts = parsed.callouts
    }
  }
  return merged
}

export function compactRound(audit: SnapshotAudit): PersistedRound {
  const last = audit.transactions.find((tx) => tx.kind === "last_callout")
  const roulette = audit.transactions.find((tx) => tx.kind === "roulette")
  return {
    id: audit.id,
    at: audit.snapshotTimestamp,
    n: audit.calloutCount,
    s: audit.confirmationStatus,
    a: audit.allocationAmount,
    tok: audit.distributionToken,
    skip: audit.skipReason,
    L: last ? compactPayout(last, audit.lastCallout) : undefined,
    R: roulette ? compactPayout(roulette, audit.rouletteWinner) : undefined,
  }
}

export function auditsFromRounds(
  rounds: PersistedRound[],
  explorerTxTemplate?: string,
): SnapshotAudit[] {
  return sanitizeRounds(rounds).map((round) => expandRound(round, explorerTxTemplate))
}

function compactPayout(tx: DistributionTx, callout?: Callout | null): PersistedPayout {
  return {
    u: tx.callerUsername,
    w: tx.wallet,
    th: callout?.thesis,
    s: callout?.source || undefined,
    sig: tx.signature,
    st: tx.status,
  }
}

function expandRound(round: PersistedRound, explorerTxTemplate?: string): SnapshotAudit {
  const token = round.tok || "TOKEN"
  const at = round.at
  const lastCallout = round.L ? payoutToCallout(round.L, token, at, "last") : placeholderCallout(token, at)
  const rouletteWinner = round.R
    ? payoutToCallout(round.R, token, at, "roulette")
    : lastCallout
  const transactions: DistributionTx[] = []
  if (round.L) transactions.push(payoutToTx("last_callout", round.L, round.a, token, at, explorerTxTemplate))
  if (round.R) transactions.push(payoutToTx("roulette", round.R, round.a, token, at, explorerTxTemplate))
  return {
    id: round.id,
    trigger: "scheduler",
    snapshotTimestamp: at,
    previousSnapshotTimestamp: null,
    windowStart: at,
    windowEnd: at,
    calloutCount: round.n,
    callouts: [lastCallout, rouletteWinner].filter(
      (row, index, all) => all.findIndex((item) => item.id === row.id) === index,
    ),
    lastCallout,
    rouletteCandidatePool: [rouletteWinner],
    rouletteIndex: 0,
    rouletteWinner,
    selectionEntropyHex: "hydrated",
    selectionMethod: "node:crypto.randomInt",
    selectionCommittedAt: at,
    animationStartedAt: at,
    allocationAmount: round.a,
    distributionToken: token,
    totalDistributed: round.a * transactions.length,
    transactions,
    confirmationStatus: round.s,
    skipReason: round.skip ?? null,
    telegramMessageIds: {},
    createdAt: at,
    completedAt: at,
  }
}

function payoutToCallout(
  payout: PersistedPayout,
  token: string,
  at: string,
  kind: string,
): Callout {
  const username = payout.u.startsWith("@") ? payout.u : `@${payout.u}`
  return {
    id: `hydrated_${kind}_${payout.w}`,
    token,
    callerUsername: username,
    wallet: payout.w,
    capturedAt: at,
    source: payout.s?.trim() || "hydrated",
    thesis: payout.th,
  }
}

function placeholderCallout(token: string, at: string): Callout {
  return {
    id: `hydrated_empty_${at}`,
    token,
    callerUsername: "@unknown",
    wallet: "11111111111111111111111111111111",
    capturedAt: at,
    source: "hydrated",
  }
}

function payoutToTx(
  kind: DistributionTx["kind"],
  payout: PersistedPayout,
  amount: number,
  token: string,
  at: string,
  explorerTxTemplate?: string,
): DistributionTx {
  const username = payout.u.startsWith("@") ? payout.u : `@${payout.u}`
  const signature = payout.sig ?? null
  const status = (payout.st as TxStatus | undefined) ?? "pending"
  return {
    kind,
    calloutId: `hydrated_${kind}_${payout.w}`,
    token,
    callerUsername: username,
    wallet: payout.w,
    amount,
    distributionToken: token,
    signature,
    explorerUrl: signature ? explorerTxUrl(signature, explorerTxTemplate) : null,
    status,
    submittedAt: at,
    confirmedAt: status === "confirmed" ? at : null,
    error: null,
  }
}

function preferredSource(next?: string, prev?: string): string | undefined {
  const n = next?.trim()
  const p = prev?.trim()
  if (n && n !== "hydrated") return n
  if (p && p !== "hydrated") return p
  return n || p || undefined
}

function mergePayout(
  next?: PersistedPayout,
  prev?: PersistedPayout,
): PersistedPayout | undefined {
  if (!next) return prev
  if (!prev) return next
  return {
    ...next,
    th: next.th || prev.th,
    s: preferredSource(next.s, prev.s),
  }
}

/** Keep prior rounds when an isolate flushes an empty ledger; preserve strong sources. */
function mergeRounds(incoming: PersistedRound[], previous: PersistedRound[]): PersistedRound[] {
  const byId = new Map(previous.map((row) => [row.id, row]))
  for (const row of incoming) {
    const prev = byId.get(row.id)
    byId.set(
      row.id,
      prev
        ? {
            ...row,
            L: mergePayout(row.L, prev.L),
            R: mergePayout(row.R, prev.R),
          }
        : row,
    )
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, MAX_PERSISTED_ROUNDS)
}

function sanitizeRounds(value: unknown): PersistedRound[] {
  if (!Array.isArray(value)) return []
  const rounds: PersistedRound[] = []
  for (const row of value) {
    if (!row || typeof row !== "object") continue
    const parsed = row as Partial<PersistedRound>
    if (typeof parsed.id !== "string" || !parsed.id) continue
    if (typeof parsed.at !== "string" || !Number.isFinite(Date.parse(parsed.at))) continue
    const status = parsed.s
    if (
      status !== "in_progress" &&
      status !== "confirmed" &&
      status !== "partial_failure" &&
      status !== "skipped"
    ) {
      continue
    }
    rounds.push({
      id: parsed.id,
      at: parsed.at,
      n: typeof parsed.n === "number" && Number.isFinite(parsed.n) ? parsed.n : 0,
      s: status,
      a: typeof parsed.a === "number" && Number.isFinite(parsed.a) ? parsed.a : 0,
      tok: typeof parsed.tok === "string" && parsed.tok.trim() ? parsed.tok.trim() : "TOKEN",
      skip: typeof parsed.skip === "string" ? parsed.skip : null,
      L: sanitizePayout(parsed.L),
      R: sanitizePayout(parsed.R),
    })
  }
  return rounds.slice(0, MAX_PERSISTED_ROUNDS)
}

function sanitizePayout(value: unknown): PersistedPayout | undefined {
  if (!value || typeof value !== "object") return undefined
  const parsed = value as Partial<PersistedPayout>
  if (typeof parsed.u !== "string" || !parsed.u.trim()) return undefined
  if (typeof parsed.w !== "string" || !parsed.w.trim()) return undefined
  return {
    u: parsed.u.trim(),
    w: parsed.w.trim(),
    th: typeof parsed.th === "string" ? parsed.th : undefined,
    s: typeof parsed.s === "string" && parsed.s.trim() ? parsed.s.trim() : undefined,
    sig: typeof parsed.sig === "string" && parsed.sig ? parsed.sig : null,
    st: typeof parsed.st === "string" ? parsed.st : undefined,
  }
}

function encodeRounds(rounds: PersistedRound[]): string {
  return gzipSync(Buffer.from(JSON.stringify(rounds), "utf8")).toString("base64url")
}

function decodeRounds(encoded: string): PersistedRound[] {
  try {
    const json = gunzipSync(Buffer.from(encoded, "base64url")).toString("utf8")
    return sanitizeRounds(JSON.parse(json) as unknown)
  } catch {
    try {
      const json = Buffer.from(encoded, "base64url").toString("utf8")
      return sanitizeRounds(JSON.parse(json) as unknown)
    } catch {
      return []
    }
  }
}

export function compactCallouts(rows: Callout[]): PersistedCaller[] {
  const byId = new Map<string, PersistedCaller>()
  for (const row of rows) {
    const packed = compactCaller(row)
    if (packed) byId.set(packed.i, packed)
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
    .slice(-MAX_WINDOW_CALLOUTS)
}

export function compactLifetimeCallouts(rows: Callout[]): PersistedCaller[] {
  const byId = new Map<string, PersistedCaller>()
  for (const row of rows) {
    const packed = compactCaller(row)
    if (packed) byId.set(packed.i, packed)
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
    .slice(-MAX_LIFETIME_CALLOUTS)
}

export function mergeLifetimeCallouts(
  existing: PersistedCaller[] | undefined,
  incoming: PersistedCaller[],
): PersistedCaller[] {
  const byId = new Map<string, PersistedCaller>()
  for (const row of existing ?? []) byId.set(row.i, row)
  for (const row of incoming) byId.set(row.i, row)
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
    .slice(-MAX_LIFETIME_CALLOUTS)
}

export function expandCallouts(rows: PersistedCaller[], token: string): Callout[] {
  return sanitizeCallers(rows).map((row) => ({
    id: row.i,
    token,
    callerUsername: row.u.startsWith("@") ? row.u : `@${row.u}`,
    wallet: row.w,
    capturedAt: row.t,
    source: row.s?.trim() || "pump-fun",
  }))
}

function compactCaller(row: Callout): PersistedCaller | null {
  if (!row.id?.trim() || !row.callerUsername?.trim() || !row.wallet?.trim()) return null
  if (!row.capturedAt || !Number.isFinite(Date.parse(row.capturedAt))) return null
  return {
    i: row.id.trim(),
    u: row.callerUsername.trim(),
    w: row.wallet.trim(),
    t: row.capturedAt,
    s: row.source?.trim() || undefined,
  }
}

function sanitizeCallers(value: unknown, max = MAX_WINDOW_CALLOUTS): PersistedCaller[] {
  if (!Array.isArray(value)) return []
  const rows: PersistedCaller[] = []
  const seen = new Set<string>()
  for (const row of value) {
    const packed = sanitizeCaller(row)
    if (!packed || seen.has(packed.i)) continue
    seen.add(packed.i)
    rows.push(packed)
  }
  return rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t)).slice(-max)
}

function sanitizeCaller(value: unknown): PersistedCaller | null {
  if (!value || typeof value !== "object") return null
  const parsed = value as Partial<PersistedCaller>
  if (typeof parsed.i !== "string" || !parsed.i.trim()) return null
  if (typeof parsed.u !== "string" || !parsed.u.trim()) return null
  if (typeof parsed.w !== "string" || !parsed.w.trim()) return null
  if (typeof parsed.t !== "string" || !Number.isFinite(Date.parse(parsed.t))) return null
  return {
    i: parsed.i.trim(),
    u: parsed.u.trim(),
    w: parsed.w.trim(),
    t: parsed.t,
    s: typeof parsed.s === "string" && parsed.s.trim() ? parsed.s.trim() : undefined,
  }
}

function packCallouts(rows: PersistedCaller[]): unknown[] {
  return rows.map((row) => [
    row.i,
    row.u,
    row.w,
    Math.floor(Date.parse(row.t) / 1000),
    row.s ?? "",
  ])
}

function unpackCallouts(value: unknown): PersistedCaller[] {
  if (!Array.isArray(value)) return []
  const rows: PersistedCaller[] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 4) continue
    const [id, username, wallet, unix, source] = entry
    if (typeof id !== "string" || typeof username !== "string" || typeof wallet !== "string") continue
    const seconds = typeof unix === "number" ? unix : Number(unix)
    if (!Number.isFinite(seconds) || seconds <= 0) continue
    rows.push({
      i: id,
      u: username,
      w: wallet,
      t: new Date(seconds * 1000).toISOString(),
      s: typeof source === "string" && source ? source : undefined,
    })
  }
  return sanitizeCallers(rows)
}

function encodeCallouts(rows: PersistedCaller[]): string | null {
  if (!rows.length) return null
  try {
    return gzipSync(Buffer.from(JSON.stringify(packCallouts(rows)), "utf8")).toString("base64url")
  } catch {
    return null
  }
}

function encodeCalloutsForPin(rows: PersistedCaller[], maxChars: number): string | null {
  const sorted = sanitizeCallers(rows)
  if (!sorted.length) return null
  let lo = 1
  let hi = sorted.length
  let best: string | null = null
  while (lo <= hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const encoded = encodeCallouts(sorted.slice(-mid))
    if (encoded && encoded.length <= maxChars) {
      best = encoded
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

function decodeCallouts(encoded: string): PersistedCaller[] {
  try {
    const json = gunzipSync(Buffer.from(encoded, "base64url")).toString("utf8")
    return unpackCallouts(JSON.parse(json) as unknown)
  } catch {
    try {
      return unpackCallouts(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown)
    } catch {
      return []
    }
  }
}

