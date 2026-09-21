import { Redis } from "@upstash/redis"
import type { PersistedWatch } from "@/engine/persist-watch"

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

export async function saveWatch(watch: PersistedWatch): Promise<void> {
  const r = redis()
  if (!r || !watch.mint?.trim()) return
  try {
    await r.set(watchKey(watch.mint), watch)
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

/** Test helper — reset the cached client between suites. */
export function resetWatchKvForTests() {
  client = undefined
}
