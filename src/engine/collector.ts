import { randomBytes } from "node:crypto"
import { encodeBase58 } from "@/lib/base58"
import { displayToken, displayUsername } from "@/lib/format"
import type { Callout } from "@/engine/types"

const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,45}$/

export function isValidWallet(wallet: string): boolean {
  return SOLANA_RE.test(wallet.trim())
}

export function isValidToken(token: string): boolean {
  return /^\$?[A-Za-z0-9_]{2,20}$/.test(token.trim())
}

export function isValidCaller(username: string): boolean {
  const value = username.trim().replace(/^@/, "")
  return value.length >= 1 && value.length <= 64
}

export function callerKey(username: string): string {
  return username.trim().replace(/^@/, "").toLowerCase()
}

export class DuplicateCalloutError extends Error {
  existing: Callout
  constructor(existing: Callout) {
    super("Caller already has a callout in this snapshot window")
    this.name = "DuplicateCalloutError"
    this.existing = existing
  }
}

export function isDuplicateCalloutError(error: unknown): error is DuplicateCalloutError {
  return (
    error instanceof DuplicateCalloutError ||
    (error instanceof Error &&
      error.name === "DuplicateCalloutError" &&
      "existing" in error)
  )
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
  thesis?: string
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
    thesis: input.thesis?.trim() || undefined,
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
   * One callout per username or wallet in the current snapshot window.
   * Live ingest can replace the row when Pump/Axiom sends a new activity id.
   */
  ingestUnique(
    input: Parameters<typeof normalizeCallout>[0],
    windowStart: Date,
    options?: { replace?: boolean },
  ): { callout: Callout; duplicate: boolean } {
    const callout = normalizeCallout(input)
    const existing = this.findDuplicate(callout, windowStart)
    if (existing) {
      const canReplace = Boolean(options?.replace && callout.id && existing.id !== callout.id)
      if (!canReplace) return { callout: existing, duplicate: true }
      this.callouts = this.callouts.filter((row) => row !== existing)
    }
    this.callouts.push(callout)
    if (this.callouts.length > 5_000) {
      this.callouts = this.callouts.slice(-4_000)
    }
    return { callout, duplicate: false }
  }

  findDuplicate(callout: Pick<Callout, "callerUsername" | "wallet" | "capturedAt">, windowStart: Date): Callout | null {
    const startIso = windowStart.toISOString()
    const user = callerKey(callout.callerUsername)
    const wallet = callout.wallet.trim()
    return (
      this.callouts.find(
        (item) =>
          item.capturedAt >= startIso &&
          (callerKey(item.callerUsername) === user || item.wallet === wallet),
      ) ?? null
    )
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

  merge(rows: Callout[], windowStart: Date) {
    for (const row of rows) {
      this.ingestUnique(
        {
          token: row.token,
          callerUsername: row.callerUsername,
          wallet: row.wallet,
          source: row.source,
          capturedAt: row.capturedAt,
          id: row.id,
          thesis: row.thesis,
        },
        windowStart,
      )
    }
  }

  /** Drop settled-window rows after a snapshot clock is restored on a new isolate. */
  dropAtOrBefore(iso: string) {
    this.callouts = this.callouts.filter((callout) => callout.capturedAt > iso)
  }

  clear() {
    this.callouts = []
  }
}
