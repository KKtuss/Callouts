import { randomBytes } from "node:crypto"
import { encodeBase58 } from "@/lib/base58"
import { displayToken, displayUsername } from "@/lib/format"
import type { Callout } from "@/engine/types"

const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,45}$/

export function isValidWallet(wallet: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,45}$/.test(wallet.trim())
}

export function isValidToken(token: string): boolean {
  return /^\$?[A-Za-z0-9_]{2,20}$/.test(token.trim())
}

export function isValidCaller(username: string): boolean {
  const value = username.trim().replace(/^@/, "")
  return /^[A-Za-z0-9_]{2,32}$/.test(value)
}

export function generateWallet(): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const wallet = encodeBase58(randomBytes(32))
    if (isValidWallet(wallet)) return wallet
  }
  throw new Error("Failed to generate a valid demo wallet")
}

export function normalizeCallout(input: {
  token: string
  callerUsername: string
  wallet: string
  source: string
  capturedAt?: string
  id?: string
}): Callout {
  if (!isValidToken(input.token)) {
    throw new Error("Invalid callout token")
  }
  if (!isValidCaller(input.callerUsername)) {
    throw new Error("Invalid caller username")
  }
  if (!isValidWallet(input.wallet)) {
    throw new Error("Invalid recipient wallet")
  }
  if (!input.source.trim()) {
    throw new Error("Callout source is required")
  }

  return {
    id: input.id ?? `co_${randomBytes(8).toString("hex")}`,
    token: displayToken(input.token),
    callerUsername: displayUsername(input.callerUsername),
    wallet: input.wallet.trim(),
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    source: input.source.trim(),
  }
}

export class CalloutCollector {
  private callouts: Callout[] = []

  ingest(input: Parameters<typeof normalizeCallout>[0]): Callout {
    const callout = normalizeCallout(input)
    this.callouts.push(callout)
    if (this.callouts.length > 5_000) {
      this.callouts = this.callouts.slice(-4_000)
    }
    return callout
  }

  /**
   * Freeze the window at snapshot time. Callouts after `end` are excluded.
   */
  captureWindow(start: Date, end: Date): Callout[] {
    const startIso = start.toISOString()
    const endIso = end.toISOString()
    return this.callouts.filter((callout) => callout.capturedAt >= startIso && callout.capturedAt <= endIso)
  }

  listSince(start: Date): Callout[] {
    const startIso = start.toISOString()
    return this.callouts.filter((callout) => callout.capturedAt >= startIso)
  }

  all(): Callout[] {
    return [...this.callouts]
  }
}
