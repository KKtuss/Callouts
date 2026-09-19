import { isValidWallet } from "@/engine/collector"
import { canonicalToken, displayToken, tokensMatch } from "@/lib/format"
import type { EngineConfig } from "@/engine/types"

export const AIDEN_MINT = "4i5FqkfYDAPcEVcXyuVyaaBcz3bpwJPqDkmaF36kpump"

/** Standard Pump.fun mint supply (1B). 1% = 10_000_000. */
export const PUMP_TOTAL_SUPPLY = 1_000_000_000
export const DEFAULT_MIGRATION_BONUS = 10_000_000
export const LAMPORTS_PER_SOL = 1_000_000_000
/** Pump.fun graduation threshold (~85 SOL of real reserves). */
export const PUMP_BOND_TARGET_SOL = 85
export const PUMP_BOND_TARGET_LAMPORTS = PUMP_BOND_TARGET_SOL * LAMPORTS_PER_SOL

const KNOWN_MINTS: Record<string, { ticker: string; name: string }> = {
  [AIDEN_MINT]: { ticker: "AIDEN", name: "The Day Trader" },
}

export function isMintAddress(value: string): boolean {
  return isValidWallet(value)
}

export function knownCoin(mint: string): { ticker: string; name: string } | null {
  return KNOWN_MINTS[mint] ?? null
}

export function resolveCoinFromEnv(env: NodeJS.ProcessEnv = process.env): {
  distributionToken: string
  coinMint: string | null
  coinName: string | null
} {
  const calloutRaw = env.CALLOUT_TOKEN?.trim() || ""
  const mintRaw = env.CALLOUT_MINT?.trim() || ""
  const tickerRaw = env.CALLOUT_TICKER?.trim() || env.DISTRIBUTION_TOKEN?.trim() || ""
  const nameRaw = env.CALLOUT_NAME?.trim() || ""

  let coinMint = mintRaw || null
  if (!coinMint && calloutRaw && isMintAddress(calloutRaw)) {
    coinMint = calloutRaw
  }

  let distributionToken = "BONK"
  if (tickerRaw && !isMintAddress(tickerRaw)) {
    distributionToken = canonicalToken(tickerRaw)
  } else if (calloutRaw && !isMintAddress(calloutRaw)) {
    distributionToken = canonicalToken(calloutRaw)
  } else if (coinMint) {
    const known = knownCoin(coinMint)
    if (known) distributionToken = known.ticker
  }

  const known = coinMint ? knownCoin(coinMint) : null
  return {
    distributionToken,
    coinMint,
    coinName: nameRaw || known?.name || null,
  }
}

export function isAllowedCalloutToken(token: string, config: Pick<EngineConfig, "distributionToken" | "coinMint">): boolean {
  const value = token.trim()
  if (!value) return true
  if (config.coinMint && value === config.coinMint) return true
  return tokensMatch(value, config.distributionToken)
}

export function resolveCalloutToken(
  token: string | undefined,
  config: Pick<EngineConfig, "distributionToken" | "coinMint">,
): string {
  const value = token?.trim() || config.distributionToken
  if (!isAllowedCalloutToken(value, config)) {
    throw new Error(`Only ${displayToken(config.distributionToken)} callouts are accepted`)
  }
  return config.distributionToken
}

export type CoinBondingStatus = {
  mint: string
  ticker: string
  name: string | null
  complete: boolean
  migrated: boolean
  realSolLamports: number
  solRaised: number
  solTarget: number
  progressPercent: number
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function parseRealSolLamports(payload: Record<string, unknown>): number {
  const raw = asNumber(payload.real_sol_reserves) ?? asNumber(payload.realSolReserves) ?? 0
  return Math.max(0, raw)
}

/**
 * Pump.fun fill percent from real SOL reserves. Caps at 99% until the coin
 * actually migrates so the bar never reads complete early.
 */
export function bondingCurveProgress(input: {
  migrated: boolean
  complete?: boolean
  realSolLamports: number
  solTarget?: number
}): { solRaised: number; solTarget: number; progressPercent: number } {
  const solTarget = input.solTarget ?? PUMP_BOND_TARGET_SOL
  const solRaised = input.realSolLamports / LAMPORTS_PER_SOL
  if (input.migrated || input.complete) {
    return { solRaised: Math.max(solRaised, solTarget), solTarget, progressPercent: 100 }
  }
  const raw = solTarget > 0 ? (solRaised / solTarget) * 100 : 0
  return {
    solRaised,
    solTarget,
    progressPercent: Math.max(0, Math.min(99, Math.floor(raw))),
  }
}

export function isCoinMigrated(payload: Record<string, unknown>): boolean {
  if (payload.complete === true) return true
  if (asString(payload.raydium_pool)) return true
  if (asString(payload.pump_swap_pool)) return true
  if (asString(payload.migrated_pool)) return true
  if (payload.migrated === true) return true
  return false
}

export async function fetchCoinMetadata(
  mint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ticker: string; name: string | null }> {
  const status = await fetchCoinBondingStatus(mint, fetchImpl)
  return { ticker: status.ticker, name: status.name }
}

export async function fetchCoinBondingStatus(
  mint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CoinBondingStatus> {
  const known = knownCoin(mint)
  const emptyCurve = bondingCurveProgress({ migrated: false, realSolLamports: 0 })
  const fallback: CoinBondingStatus = {
    mint,
    ticker: known?.ticker ?? "TOKEN",
    name: known?.name ?? null,
    complete: false,
    migrated: false,
    realSolLamports: 0,
    ...emptyCurve,
  }
  try {
    const response = await fetchImpl(`https://frontend-api-v3.pump.fun/coins/${encodeURIComponent(mint)}`, {
      headers: { Accept: "application/json", "User-Agent": "callout-snap/0.1" },
      cache: "no-store",
    })
    if (!response.ok) return fallback
    const payload = (await response.json()) as Record<string, unknown>
    const rawSymbol = asString(payload.symbol) ?? ""
    const cleaned = rawSymbol.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20)
    const ticker = cleaned.length >= 2 ? canonicalToken(cleaned) : (known?.ticker ?? "TOKEN")
    const name = asString(payload.name) ?? known?.name ?? null
    const migrated = isCoinMigrated(payload)
    const complete = payload.complete === true
    const realSolLamports = parseRealSolLamports(payload)
    const curve = bondingCurveProgress({ migrated, complete, realSolLamports })
    return {
      mint,
      ticker,
      name,
      complete,
      migrated,
      realSolLamports,
      ...curve,
    }
  } catch {
    return fallback
  }
}
