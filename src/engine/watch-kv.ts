import { randomBytes } from "node:crypto"
import { Redis } from "@upstash/redis"
import type { PersistedWatch } from "@/engine/persist-watch"

const EPOCH_KEY = "callout:epoch"
const LEADER_KEY = "callout:leader"
const LEADER_WORK_KEY = "callout:leader-work"
const LEADER_TTL_MS = 45_000
const LEADER_STALE_MS = 15_000

type CalloutKvGlobal = typeof globalThis & {
  __calloutEpoch?: number
  __calloutIsolate?: string
}

const kvGlobal = globalThis as CalloutKvGlobal

export function localEpochNow(): number {
  return kvGlobal.__calloutEpoch ?? 0
}

export function noteEpoch(epoch: number) {
  if (Number.isFinite(epoch) && epoch >= 0) kvGlobal.__calloutEpoch = epoch
}

function isolateId(): string {
  if (!kvGlobal.__calloutIsolate) kvGlobal.__calloutIsolate = randomBytes(8).toString("hex")
  return kvGlobal.__calloutIsolate
}

let client: Redis | null | undefined

export function kvEnabled(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
  )
}

function redis(): Redis | null {
  if (!kvEnabled()) return null
  if (client === undefined) {
    client = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!.trim(),
      token: process.env.UPSTASH_REDIS_REST_TOKEN!.trim(),
    })
  }
  return client ?? null
}

export function watchKey(mint: string): string {
  return `callout:watch:${mint.trim()}`
}

export async function loadWatch(mint: string): Promise<PersistedWatch | null> {
  const r = redis()
  if (!r || !mint.trim()) return null
  try {
    const raw = await r.get<PersistedWatch | string>(watchKey(mint))
    if (!raw) return null
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as PersistedWatch
      } catch {
        return null
      }
    }
    return raw
  } catch (error) {
    console.warn("[watch-kv] load failed", error)
    return null
  }
}

const SAVE_IF_CURRENT_SCRIPT = `
local epoch = redis.call('GET', KEYS[1]) or '0'
if epoch ~= ARGV[1] then
  return '0'
end
redis.call('SET', KEYS[2], ARGV[2])
return '1'
`

export async function saveWatch(watch: PersistedWatch): Promise<void> {
  const r = redis()
  if (!r || !watch.mint?.trim()) return
  try {
    const result = await r.eval(
      SAVE_IF_CURRENT_SCRIPT,
      [EPOCH_KEY, watchKey(watch.mint)],
      [String(localEpochNow()), JSON.stringify(watch)],
    )
    if (String(result) !== "1") {
      console.warn(`[watch-kv] save skipped — this copy is generation ${localEpochNow()}`)
    }
  } catch (error) {
    console.warn("[watch-kv] save failed", error)
  }
}

export async function deleteWatch(mint: string | null | undefined): Promise<void> {
  const r = redis()
  const keyMint = mint?.trim()
  if (!r || !keyMint) return
  try {
    await r.del(watchKey(keyMint))
  } catch (error) {
    console.warn("[watch-kv] delete failed", error)
  }
}

const SNAPSHOT_LOCK_TTL_MS = 4 * 60_000

function snapshotLockKey(mint: string): string {
  return `callout:snaplock:${mint.trim()}`
}

/**
 * One snapshot at a time across Vercel isolates. Returns false when another
 * isolate already holds the lock. With no Redis configured, returns true so
 * local tests still run.
 */
export async function acquireSnapshotLock(
  mint: string,
  owner: string,
  ttlMs = SNAPSHOT_LOCK_TTL_MS,
): Promise<boolean> {
  const r = redis()
  if (!r || !mint.trim() || !owner) return true
  try {
    const result = await r.set(snapshotLockKey(mint), owner, { nx: true, px: ttlMs })
    return result === "OK"
  } catch (error) {
    console.warn("[watch-kv] snapshot lock failed", error)
    return false
  }
}

export async function releaseSnapshotLock(mint: string, owner: string): Promise<void> {
  const r = redis()
  if (!r || !mint.trim() || !owner) return
  const key = snapshotLockKey(mint)
  try {
    const current = await r.get<string>(key)
    if (current === owner) await r.del(key)
  } catch (error) {
    console.warn("[watch-kv] snapshot unlock failed", error)
  }
}

const RESERVE_WINDOW_SCRIPT = `
local existing = tonumber(redis.call('GET', KEYS[1]) or '0')
local now = tonumber(ARGV[1])
local gap = tonumber(ARGV[2])
local known = tonumber(ARGV[3])
local last = existing
if known > last then
  last = known
end
if last > 0 and (now - last) < gap then
  if last > existing then
    redis.call('SET', KEYS[1], tostring(last))
  end
  return '0'
end
redis.call('SET', KEYS[1], ARGV[1])
return '1'
`

function snapshotAtKey(mint: string): string {
  return `callout:snapat:${mint.trim()}`
}

function bondKey(mint: string): string {
  return `callout:bond:${mint.trim()}`
}

/**
 * One Telegram bond announcement per mint until the next wipe deletes the key.
 * "taken" means another copy already owns it. "unavailable" means Redis failed
 * and the caller should retry without posting.
 */
export async function claimBondAnnouncement(
  mint: string,
): Promise<"claimed" | "taken" | "unavailable"> {
  const r = redis()
  if (!r || !mint.trim()) return "claimed"
  try {
    const result = await r.set(bondKey(mint), isolateId(), { nx: true })
    return result === "OK" ? "claimed" : "taken"
  } catch (error) {
    console.warn("[watch-kv] bond claim failed", error)
    return "unavailable"
  }
}

/**
 * Atomically claim the next snapshot time. A stale isolate cannot overwrite
 * this key via the watch ledger, so two rounds cannot start inside minGap.
 * Returns true when this caller may run the snapshot.
 */
export async function reserveSnapshotWindow(
  mint: string,
  nowMs: number,
  minGapMs: number,
  knownLastMs = 0,
): Promise<boolean> {
  const r = redis()
  if (!r || !mint.trim()) return true
  try {
    const result = await r.eval(
      RESERVE_WINDOW_SCRIPT,
      [snapshotAtKey(mint)],
      [String(nowMs), String(Math.max(0, Math.floor(minGapMs))), String(Math.max(0, Math.floor(knownLastMs)))],
    )
    return String(result) === "1"
  } catch (error) {
    console.warn("[watch-kv] snapshot window reserve failed", error)
    return false
  }
}

export async function clearSnapshotWindow(mint: string | null | undefined): Promise<void> {
  const r = redis()
  const keyMint = mint?.trim()
  if (!r || !keyMint) return
  try {
    await r.del(snapshotAtKey(keyMint))
  } catch (error) {
    console.warn("[watch-kv] snapshot window clear failed", error)
  }
}

export async function readEpoch(): Promise<number> {
  const r = redis()
  if (!r) return 0
  try {
    const raw = await r.get<number | string>(EPOCH_KEY)
    const epoch = typeof raw === "number" ? raw : Number(raw ?? 0)
    return Number.isFinite(epoch) && epoch > 0 ? epoch : 0
  } catch (error) {
    console.warn("[watch-kv] epoch read failed", error)
    return localEpochNow()
  }
}

/**
 * Invalidate every other isolate. The caller becomes the only leader, and
 * in-flight saves from the previous generation fail the epoch check.
 */
export async function bumpEpoch(options?: {
  mints?: Array<string | null | undefined>
}): Promise<number> {
  const mints = [
    ...new Set(
      (options?.mints ?? []).map((mint) => mint?.trim() || "").filter((mint) => mint.length > 0),
    ),
  ]
  const deleteKeys: string[] = []
  for (const mint of mints) {
    deleteKeys.push(watchKey(mint), snapshotAtKey(mint), snapshotLockKey(mint), bondKey(mint))
  }
  deleteKeys.push(LEADER_WORK_KEY)
  const r = redis()
  if (!r) {
    noteEpoch(localEpochNow() + 1)
    return localEpochNow()
  }
  const script = `
local epoch = redis.call('INCR', KEYS[1])
redis.call('SET', KEYS[2], ARGV[2], 'PX', tonumber(ARGV[3]))
local deletes = tonumber(ARGV[1])
for i = 1, deletes do
  redis.call('DEL', KEYS[2 + i])
end
return epoch
`
  try {
    const raw = await r.eval(script, [EPOCH_KEY, LEADER_KEY, ...deleteKeys], [
      String(deleteKeys.length),
      leaderPayload(),
      String(LEADER_TTL_MS),
    ])
    const epoch = typeof raw === "number" ? raw : Number(raw)
    const next = Number.isFinite(epoch) && epoch > 0 ? epoch : localEpochNow() + 1
    noteEpoch(next)
    return next
  } catch (error) {
    console.warn("[watch-kv] epoch bump failed", error)
    try {
      const raw = await r.incr(EPOCH_KEY)
      const epoch = typeof raw === "number" ? raw : Number(raw)
      await r.set(LEADER_KEY, leaderPayload(), { px: LEADER_TTL_MS })
      if (deleteKeys.length) await r.del(...deleteKeys)
      const next = Number.isFinite(epoch) && epoch > 0 ? epoch : localEpochNow() + 1
      noteEpoch(next)
      return next
    } catch (fallbackError) {
      console.warn("[watch-kv] epoch bump fallback failed", fallbackError)
      noteEpoch(localEpochNow() + 1)
      return localEpochNow()
    }
  }
}

function leaderPayload(): string {
  return `${isolateId()}:${Date.now()}`
}

function parseLeader(raw: string | null | undefined): { id: string; at: number } | null {
  if (!raw) return null
  const colon = raw.lastIndexOf(":")
  if (colon <= 0) return { id: raw, at: 0 }
  const at = Number(raw.slice(colon + 1))
  return { id: raw.slice(0, colon), at: Number.isFinite(at) ? at : 0 }
}

/** The wipe/launch copy must be able to publish after a long Telegram purge. */
export async function takeLeadership(): Promise<void> {
  const r = redis()
  if (!r) return
  try {
    await r.set(LEADER_KEY, leaderPayload(), { px: LEADER_TTL_MS })
  } catch (error) {
    console.warn("[watch-kv] leader take failed", error)
  }
}

export async function touchLeaderWork(): Promise<void> {
  const r = redis()
  if (!r) return
  try {
    await r.set(LEADER_WORK_KEY, String(Date.now()), { px: LEADER_TTL_MS })
  } catch (error) {
    console.warn("[watch-kv] leader work touch failed", error)
  }
}

/** One isolate may run pollers, the scheduler, and channel publishes. */
export async function claimLeadership(): Promise<boolean> {
  const r = redis()
  if (!r) return true
  const id = isolateId()
  const payload = leaderPayload()
  try {
    const claimed = await r.set(LEADER_KEY, payload, { nx: true, px: LEADER_TTL_MS })
    if (claimed === "OK") {
      await touchLeaderWork()
      return true
    }
    const holder = parseLeader(await r.get<string>(LEADER_KEY))
    if (holder?.id === id) {
      await r.set(LEADER_KEY, payload, { px: LEADER_TTL_MS })
      await touchLeaderWork()
      return true
    }
    // Steal only a leader whose heartbeat has gone quiet. A missing work
    // stamp is normal for the first seconds after a claim.
    const heartbeatStale = !holder || Date.now() - holder.at > LEADER_STALE_MS
    if (heartbeatStale) {
      await r.set(LEADER_KEY, payload, { px: LEADER_TTL_MS })
      await touchLeaderWork()
      return true
    }
    return false
  } catch (error) {
    console.warn("[watch-kv] leader claim failed", error)
    return false
  }
}

/** Test helper — reset the cached client between suites. */
export function resetWatchKvForTests() {
  client = undefined
  kvGlobal.__calloutEpoch = 0
  kvGlobal.__calloutIsolate = ""
}
