import { Redis } from "@upstash/redis"
import { isValidWallet } from "@/engine/collector"
import { kvEnabled } from "@/engine/watch-kv"

const HASH_KEY = "callout:fomo-wallets"

let client: Redis | null | undefined

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

function normHandle(handle: string): string {
  return handle.replace(/^@/, "").trim().toLowerCase()
}

/** Seed from env: FOMO_WALLET_MAP=handle:Wallet,handle2:Wallet2 */
export function walletsFromEnv(): Map<string, string> {
  const map = new Map<string, string>()
  const raw = process.env.FOMO_WALLET_MAP?.trim()
  if (!raw) return map
  for (const part of raw.split(/[,;\n]+/)) {
    const [h, w] = part.split(":").map((s) => s.trim())
    if (h && w && isValidWallet(w)) map.set(normHandle(h), w)
  }
  return map
}

export async function loadFomoWallet(handle: string): Promise<string | null> {
  const key = normHandle(handle)
  if (!key) return null
  const fromEnv = walletsFromEnv().get(key)
  if (fromEnv) return fromEnv
  const r = redis()
  if (!r) return null
  try {
    const wallet = await r.hget<string>(HASH_KEY, key)
    if (wallet && isValidWallet(wallet)) return wallet
  } catch (error) {
    console.warn("[fomo-wallets] load failed", error)
  }
  return null
}

export async function saveFomoWallet(handle: string, wallet: string): Promise<void> {
  const key = normHandle(handle)
  if (!key || !isValidWallet(wallet)) return
  const r = redis()
  if (!r) return
  try {
    await r.hset(HASH_KEY, { [key]: wallet })
  } catch (error) {
    console.warn("[fomo-wallets] save failed", error)
  }
}

export function resetFomoWalletsForTests() {
  client = undefined
}
