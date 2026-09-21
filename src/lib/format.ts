export function pad2(n: number): string {
  return n.toString().padStart(2, "0")
}

export function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export function formatClockIso(iso: string): string {
  return formatClock(new Date(iso))
}

export function formatDateTimeIso(iso: string): string {
  const date = new Date(iso)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatClock(date)}`
}

export function formatInteger(value: number): string {
  return value.toLocaleString("en-US")
}

export function formatSnapshotWindow(start: Date, end: Date): string {
  return `${formatClock(start)} → ${formatClock(end)}`
}

export function truncateWallet(wallet: string, head = 3, tail = 3): string {
  if (wallet.length <= head + tail + 1) return wallet
  return `${wallet.slice(0, head)}...${wallet.slice(-tail)}`
}

export function truncateSig(signature: string, head = 3, tail = 3): string {
  return truncateWallet(signature, head, tail)
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export function displayUsername(username: string): string {
  const trimmed = username.trim()
  if (!trimmed) return "@unknown"
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`
}

/** Human label for callout origin (FOMO / Pump.fun / Axiom). */
export function calloutSourceLabel(source: string): string | null {
  const s = source.trim().toLowerCase()
  if (!s || s === "other" || s === "none" || s === "hydrated" || s === "demo-feed") return null
  if (s.includes("fomo")) return "FOMO"
  if (s.includes("pump")) return "Pump.fun"
  if (s.includes("axiom")) return "Axiom"
  return null
}

export function displayToken(token: string): string {
  const trimmed = token.trim()
  if (!trimmed) return "$UNKNOWN"
  return trimmed.startsWith("$") ? trimmed.toUpperCase() : `$${trimmed.toUpperCase()}`
}

/** Canonical ticker without `$`, e.g. BONK. */
export function canonicalToken(token: string): string {
  return displayToken(token).replace(/^\$/, "")
}

export function tokensMatch(a: string, b: string): boolean {
  return displayToken(a) === displayToken(b)
}

export function minutesLabel(minMs: number, maxMs: number): string {
  const min = Math.round(minMs / 60_000)
  const max = Math.round(maxMs / 60_000)
  return `${min}–${max} minutes`
}

export function formatAmount(amount: number, token: string): string {
  if (canonicalToken(token) === "SOL") {
    return `${formatSolAmount(amount)} SOL`
  }
  return `${formatInteger(amount)} ${token}`
}

/** 10-cell Telegram/console bar, e.g. `██████░░░░`. */
export function progressBar(percent: number, width = 10): string {
  const cells = Math.max(1, Math.round(width))
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * cells)
  return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`
}

export function formatSol(sol: number): string {
  return sol.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** SOL amount for the public board, e.g. `12.48`. */
export function formatSolAmount(sol: number): string {
  if (sol <= 0) return "0.00"
  if (sol < 0.01) return "<0.01"
  return sol.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Share of total supply, e.g. `0.25%`. */
export function formatSupplyPercent(percent: number): string {
  if (percent <= 0) return "0%"
  if (percent < 0.01) return "<0.01%"
  return `${percent.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
}

/** Human elapsed time for live counters, e.g. `7m 04s`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${pad2(minutes)}m`
  if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`
  return `${seconds}s`
}

export const DIVIDER = "━━━━━━━━━━━━━━━━━━"
