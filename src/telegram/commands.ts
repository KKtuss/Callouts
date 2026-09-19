/**
 * Commands that must never exist on the public Telegram bot.
 * The public presence is a broadcast channel — not a control bot.
 */
export const FORBIDDEN_PUBLIC_COMMANDS = [
  "status",
  "balance",
  "config",
  "pause",
  "resume",
  "snapshot",
  "next",
  "admin",
  "start",
  "help",
  "wallet",
  "treasury",
  "allocate",
  "allocation",
  "source",
  "sources",
  "callout",
] as const

export type ForbiddenCommand = (typeof FORBIDDEN_PUBLIC_COMMANDS)[number]

export function isForbiddenPublicCommand(command: string): boolean {
  const normalized = command.trim().replace(/^\//, "").toLowerCase()
  return FORBIDDEN_PUBLIC_COMMANDS.includes(normalized as ForbiddenCommand)
}

/**
 * Inbound Telegram updates are dropped. Telegram is not a control plane.
 */
export function ignoreInboundUpdate(update: unknown): { ignored: true; reason: string } {
  void update
  return {
    ignored: true,
    reason: "Public Telegram presence is broadcast-only. Inbound updates are discarded.",
  }
}
