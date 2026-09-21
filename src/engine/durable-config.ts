/**
 * Durable operational config — persisted to Redis so every cold-start isolate
 * picks up the current settings without a Vercel redeploy.
 *
 * Redis key: callout:config
 *
 * The treasury private key is AES-256-GCM encrypted using a key derived from
 * ADMIN_KEY (which lives only in Vercel env vars). Redis never sees the raw key.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
} from "node:crypto"
import { Redis } from "@upstash/redis"

// ─── Types ────────────────────────────────────────────────────────────────────

export type DurableConfig = {
  /** FOMO treasury public address — FOMO winner payouts routed here. */
  fomoTreasuryWallet: string | null
  /** Pump treasury public address — shown in status, derived from key. */
  treasuryPublicAddress: string | null
  /** AES-256-GCM ciphertext of the raw private key (base58). Null = no key. */
  encryptedTreasuryKey: string | null
  /** Minimum ms between snapshots. */
  snapshotMinMs: number | null
  /** Maximum ms between snapshots. */
  snapshotMaxMs: number | null
  /** Token allocation per winner per snapshot. */
  allocationAmount: number | null
  /** Basis points of creator SOL rewards paid out post-bond. */
  creatorRewardShareBps: number | null
  /** Watched mint. Absent on older configs — env mint stays until a start/stop writes this. */
  coinMint?: string | null
  coinName?: string | null
  distributionToken?: string | null
}

const REDIS_KEY = "callout:config"

// ─── Redis client ──────────────────────────────────────────────────────────

let _client: Redis | null | undefined

function redis(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL?.trim() || !process.env.UPSTASH_REDIS_REST_TOKEN?.trim()) {
    return null
  }
  if (_client === undefined) {
    _client = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL.trim(),
      token: process.env.UPSTASH_REDIS_REST_TOKEN.trim(),
    })
  }
  return _client ?? null
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function loadDurableConfig(): Promise<DurableConfig | null> {
  const r = redis()
  if (!r) return null
  try {
    const raw = await r.get<DurableConfig | string>(REDIS_KEY)
    if (!raw) return null
    if (typeof raw === "string") {
      try { return JSON.parse(raw) as DurableConfig } catch { return null }
    }
    return raw
  } catch (error) {
    console.warn("[durable-config] load failed", error)
    return null
  }
}

export async function saveDurableConfig(patch: Partial<DurableConfig>): Promise<void> {
  const r = redis()
  if (!r) return
  try {
    const current = await loadDurableConfig() ?? {}
    const updated: DurableConfig = {
      fomoTreasuryWallet: null,
      treasuryPublicAddress: null,
      encryptedTreasuryKey: null,
      snapshotMinMs: null,
      snapshotMaxMs: null,
      allocationAmount: null,
      creatorRewardShareBps: null,
      ...current,
      ...patch,
    }
    await r.set(REDIS_KEY, updated)
  } catch (error) {
    console.warn("[durable-config] save failed", error)
  }
}

export async function clearDurableConfig(): Promise<void> {
  const r = redis()
  if (!r) return
  try { await r.del(REDIS_KEY) } catch (error) {
    console.warn("[durable-config] clear failed", error)
  }
}

// ─── Crypto helpers ────────────────────────────────────────────────────────

type EncryptedBlob = { iv: string; data: string; tag: string }

function deriveKey(adminKey: string): Buffer {
  // PBKDF2 with a fixed application salt — key is ADMIN_KEY itself, which
  // never leaves Vercel env vars.
  return pbkdf2Sync(adminKey, "callout:treasury-key-v1", 100_000, 32, "sha256")
}

/**
 * Encrypt a raw private key string with AES-256-GCM.
 * Returns a compact JSON string safe to store in Redis.
 */
export function encryptTreasuryKey(raw: string, adminKey: string): string {
  const key = deriveKey(adminKey)
  const iv = randomBytes(16)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  const blob: EncryptedBlob = {
    iv: iv.toString("base64"),
    data: encrypted.toString("base64"),
    tag: tag.toString("base64"),
  }
  return JSON.stringify(blob)
}

/**
 * Decrypt a blob produced by `encryptTreasuryKey`.
 * Returns null if ADMIN_KEY is wrong or blob is corrupt.
 */
export function decryptTreasuryKey(ciphertext: string, adminKey: string): string | null {
  try {
    const { iv, data, tag } = JSON.parse(ciphertext) as EncryptedBlob
    const key = deriveKey(adminKey)
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"))
    decipher.setAuthTag(Buffer.from(tag, "base64"))
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(data, "base64")),
      decipher.final(),
    ])
    return decrypted.toString("utf8")
  } catch {
    return null
  }
}

/** Test helper — reset cached client. */
export function resetDurableConfigForTests() {
  _client = undefined
}
