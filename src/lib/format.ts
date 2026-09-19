export function pad2(n: number): string {
  return n.toString().padStart(2, "0")
}

export function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
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

export function displayToken(token: string): string {
  const trimmed = token.trim()
  if (!trimmed) return "$UNKNOWN"
  return trimmed.startsWith("$") ? trimmed.toUpperCase() : `$${trimmed.toUpperCase()}`
}

export function minutesLabel(minMs: number, maxMs: number): string {
  const min = Math.round(minMs / 60_000)
  const max = Math.round(maxMs / 60_000)
  return `${min}–${max} minutes`
}

export function formatAmount(amount: number, token: string): string {
  return `${amount} ${token}`
}

export const DIVIDER = "━━━━━━━━━━━━━━━━━━"
