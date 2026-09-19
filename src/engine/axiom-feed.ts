import { displayUsername } from "@/lib/format"
import { isValidWallet } from "@/engine/collector"

export type AxiomCalloutRecord = {
  calloutId: string
  tokenAddress: string
  wallet: string
  username: string
  createdAtMs: number
  thesis: string
  kind: string
  chain: string
  state: string | null
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function createdAtMsFrom(row: UnknownRecord): number | null {
  const iso = asString(row.createdAt)
  if (!iso) return null
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseAxiomCallout(raw: unknown): AxiomCalloutRecord | null {
  const row = asRecord(raw)
  if (!row) return null

  const calloutId = asString(row.id)
  const tokenAddress = asString(row.tokenAddress)
  const wallet = asString(row.walletAddress)
  const username = asString(row.callerHandle) ?? asString(row.userHandle)
  const createdAtMs = createdAtMsFrom(row)
  const kind = asString(row.kind) ?? "callout"
  const chain = asString(row.chain) ?? "sol"
  const state = asString(row.state)

  if (!calloutId || !tokenAddress || !wallet || !username || createdAtMs === null) return null
  if (!isValidWallet(wallet)) return null
  if (chain !== "sol") return null
  if (kind !== "callout") return null

  return {
    calloutId,
    tokenAddress,
    wallet,
    username: displayUsername(username).replace(/^@/, ""),
    createdAtMs,
    thesis: asString(row.body) ?? "",
    kind,
    chain,
    state,
  }
}

export function parseAxiomCalloutFeed(payload: unknown): AxiomCalloutRecord[] {
  const rows = extractRows(payload)
  return uniqueById(rows.map(parseAxiomCallout).filter((row): row is AxiomCalloutRecord => Boolean(row)))
}

function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  const root = asRecord(payload)
  if (!root) return []
  if (Array.isArray(root.callouts)) return root.callouts
  if (Array.isArray(root.data)) return root.data
  if (Array.isArray(root.items)) return root.items
  return []
}

function uniqueById(rows: AxiomCalloutRecord[]): AxiomCalloutRecord[] {
  const byId = new Map<string, AxiomCalloutRecord>()
  for (const row of rows) {
    if (!byId.has(row.calloutId)) byId.set(row.calloutId, row)
  }
  return [...byId.values()]
}

export function axiomCalloutsUrl(tokenAddress: string, baseUrl?: string): string {
  const root = (baseUrl ?? "https://api8.axiom.trade").replace(/\/$/, "")
  const params = new URLSearchParams({
    tokenAddress,
    v: "2",
  })
  return `${root}/callouts?${params.toString()}`
}
