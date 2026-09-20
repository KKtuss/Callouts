import { explorerAddressUrl, explorerTxUrl } from "@/lib/explorer"
import {
  DIVIDER,
  displayUsername,
  escapeHtml,
  formatAmount,
  formatSnapshotWindow,
  formatSol,
  minutesLabel,
  progressBar,
  truncateSig,
  truncateWallet,
} from "@/lib/format"
import type { Callout, ChannelMessageKind, DistributionTx } from "@/engine/types"

export type FormattedMessage = {
  kind: ChannelMessageKind
  html: string
  text: string
}

function pair(html: string, text: string, kind: ChannelMessageKind): FormattedMessage {
  return { kind, html, text }
}

function bold(value: string): string {
  return `<b>${escapeHtml(value)}</b>`
}

function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`
}

function link(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
}

export type ExplorerLinks = {
  txTemplate?: string
  addressTemplate?: string
}

function walletLine(wallet: string, explorer?: ExplorerLinks): { html: string; text: string } {
  const short = truncateWallet(wallet)
  const href = explorerAddressUrl(wallet, explorer?.addressTemplate)
  return {
    html: link(short, href),
    text: `\`${short}\``,
  }
}

function txLine(signature: string, explorer?: ExplorerLinks): { html: string; text: string } {
  const short = truncateSig(signature)
  const href = explorerTxUrl(signature, explorer?.txTemplate)
  return {
    html: link(short, href),
    text: `\`${short}\``,
  }
}

export function snapshotTaking(): FormattedMessage {
  const text = `📸 SNAPSHOT\nTaking snapshot...`
  const html = `📸 ${bold("SNAPSHOT")}\nTaking snapshot...`
  return pair(html, text, "snapshot")
}

export function snapshotAnnouncement(input: {
  calloutCount: number
  windowStart: Date
  windowEnd: Date
}): FormattedMessage {
  const window = formatSnapshotWindow(input.windowStart, input.windowEnd)
  const text = [
    "📸 SNAPSHOT",
    "",
    `Callouts captured: ${input.calloutCount}`,
    "",
    "Snapshot window:",
    "",
    `\`${window}\``,
    "",
    "Selecting recipients...",
  ].join("\n")

  const html = [
    `📸 ${bold("SNAPSHOT")}`,
    "",
    `Callouts captured: ${bold(String(input.calloutCount))}`,
    "",
    "Snapshot window:",
    "",
    code(window),
    "",
    "Selecting recipients...",
  ].join("\n")

  return pair(html, text, "snapshot")
}

export function rouletteStart(): FormattedMessage {
  const text = ["🎰 ROULETTE", "", "`Selecting a callout...`"].join("\n")
  const html = [`🎰 ${bold("ROULETTE")}`, "", code("Selecting a callout...")].join("\n")
  return pair(html, text, "roulette")
}

export function rouletteSpin(callerUsername: string): FormattedMessage {
  const caller = displayUsername(callerUsername)
  const text = ["🎰 ROULETTE", "", `🔄 ${caller}`].join("\n")
  const html = [`🎰 ${bold("ROULETTE")}`, "", `🔄 ${bold(caller)}`].join("\n")
  return pair(html, text, "roulette")
}

export function rouletteSelected(
  winner: Callout,
  explorer?: ExplorerLinks,
): FormattedMessage {
  const caller = displayUsername(winner.callerUsername)
  const wallet = walletLine(winner.wallet, explorer)
  const text = [
    "🎰 ROULETTE",
    "",
    "🎯 SELECTED",
    "",
    "Caller:",
    caller,
    "",
    "Wallet:",
    wallet.text,
  ].join("\n")
  const html = [
    `🎰 ${bold("ROULETTE")}`,
    "",
    `🎯 ${bold("SELECTED")}`,
    "",
    "Caller:",
    escapeHtml(caller),
    "",
    "Wallet:",
    wallet.html,
  ].join("\n")
  return pair(html, text, "roulette")
}

export function snapshotRecipients(input: {
  lastCallout: Callout
  rouletteWinner: Callout
  allocationAmount: number
  distributionToken: string
  explorer?: ExplorerLinks
}): FormattedMessage {
  const amount = formatAmount(input.allocationAmount, input.distributionToken)
  const total = formatAmount(input.allocationAmount * 2, input.distributionToken)
  const lastWallet = walletLine(input.lastCallout.wallet, input.explorer)
  const rouletteWallet = walletLine(input.rouletteWinner.wallet, input.explorer)

  const text = [
    "📸 SNAPSHOT COMPLETE",
    "",
    DIVIDER,
    "",
    "🥇 LAST CALLOUT",
    "",
    "Caller:",
    displayUsername(input.lastCallout.callerUsername),
    "",
    "Wallet:",
    lastWallet.text,
    "",
    "Allocation:",
    amount,
    "",
    DIVIDER,
    "",
    "🎰 ROULETTE WINNER",
    "",
    "Caller:",
    displayUsername(input.rouletteWinner.callerUsername),
    "",
    "Wallet:",
    rouletteWallet.text,
    "",
    "Allocation:",
    amount,
    "",
    DIVIDER,
    "",
    "💰 TOTAL DISTRIBUTION",
    "",
    total,
  ].join("\n")

  const html = [
    `📸 ${bold("SNAPSHOT COMPLETE")}`,
    "",
    DIVIDER,
    "",
    `🥇 ${bold("LAST CALLOUT")}`,
    "",
    "Caller:",
    escapeHtml(displayUsername(input.lastCallout.callerUsername)),
    "",
    "Wallet:",
    lastWallet.html,
    "",
    "Allocation:",
    bold(amount),
    "",
    DIVIDER,
    "",
    `🎰 ${bold("ROULETTE WINNER")}`,
    "",
    "Caller:",
    escapeHtml(displayUsername(input.rouletteWinner.callerUsername)),
    "",
    "Wallet:",
    rouletteWallet.html,
    "",
    "Allocation:",
    bold(amount),
    "",
    DIVIDER,
    "",
    `💰 ${bold("TOTAL DISTRIBUTION")}`,
    "",
    bold(total),
  ].join("\n")

  return pair(html, text, "recipients")
}

export function distributionPreparing(): FormattedMessage {
  const text = ["⏳ DISTRIBUTION", "Preparing..."].join("\n")
  const html = [`⏳ ${bold("DISTRIBUTION")}`, "Preparing..."].join("\n")
  return pair(html, text, "distribution")
}

export function distributionSending(
  tx: DistributionTx,
  alreadyConfirmed: DistributionTx[] = [],
  explorer?: ExplorerLinks,
): FormattedMessage {
  const amount = formatAmount(tx.amount, tx.distributionToken)
  const wallet = walletLine(tx.wallet, explorer)
  const prior = alreadyConfirmed
    .map((item) => formatConfirmedBlock(item, explorer))
    .filter((block) => block.text)
  const bodyText = [
    "⏳ SENDING",
    "",
    amount,
    "",
    `→ ${wallet.text}`,
    "",
    "Confirming transaction...",
  ].join("\n")
  const bodyHtml = [
    `⏳ ${bold("SENDING")}`,
    "",
    bold(amount),
    "",
    `→ ${wallet.html}`,
    "",
    "Confirming transaction...",
  ].join("\n")

  const text = prior.length ? `${prior.map((b) => b.text).join("\n\n")}\n\n${bodyText}` : bodyText
  const html = prior.length ? `${prior.map((b) => b.html).join("\n\n")}\n\n${bodyHtml}` : bodyHtml
  return pair(html, text, "distribution")
}

export function distributionConfirmed(
  txs: DistributionTx[],
  explorer?: ExplorerLinks,
): FormattedMessage {
  const blocks = txs.map((tx) => formatConfirmedBlock(tx, explorer))
  const text = blocks.map((b) => b.text).join("\n\n")
  const html = blocks.map((b) => b.html).join("\n\n")
  return pair(html, text, "distribution")
}

function formatConfirmedBlock(
  tx: DistributionTx | undefined,
  explorer?: ExplorerLinks,
): { html: string; text: string } {
  if (!tx) return { html: "", text: "" }
  const amount = formatAmount(tx.amount, tx.distributionToken)
  const wallet = walletLine(tx.wallet, explorer)

  if (tx.status === "failed") {
    return {
      text: [
        "❌ FAILED",
        "",
        amount,
        "",
        `→ ${wallet.text}`,
        "",
        tx.error ?? "Treasury send failed.",
      ].join("\n"),
      html: [
        `❌ ${bold("FAILED")}`,
        "",
        bold(amount),
        "",
        `→ ${wallet.html}`,
        "",
        escapeHtml(tx.error ?? "Treasury send failed."),
      ].join("\n"),
    }
  }

  const sig = tx.signature ? txLine(tx.signature, explorer) : null
  return {
    text: [
      "✅ SENT",
      "",
      amount,
      "",
      `→ ${wallet.text}`,
      "",
      "TX:",
      sig?.text ?? "`pending`",
      "",
      "Confirmed on-chain.",
    ].join("\n"),
    html: [
      `✅ ${bold("SENT")}`,
      "",
      bold(amount),
      "",
      `→ ${wallet.html}`,
      "",
      "TX:",
      sig?.html ?? code("pending"),
      "",
      "Confirmed on-chain.",
    ].join("\n"),
  }
}

export function snapshotFinal(input: {
  lastCallout: Callout
  rouletteWinner: Callout
  lastTx: DistributionTx
  rouletteTx: DistributionTx
  allocationAmount: number
  distributionToken: string
  snapshotMinMs: number
  snapshotMaxMs: number
  explorer?: ExplorerLinks
}): FormattedMessage {
  const amount = formatAmount(input.allocationAmount, input.distributionToken)
  const total = formatAmount(input.allocationAmount * 2, input.distributionToken)
  const lastWallet = walletLine(input.lastCallout.wallet, input.explorer)
  const rouletteWallet = walletLine(input.rouletteWinner.wallet, input.explorer)
  const lastSig = input.lastTx.signature
    ? txLine(input.lastTx.signature, input.explorer)
    : { html: code("unconfirmed"), text: "`unconfirmed`" }
  const rouletteSig = input.rouletteTx.signature
    ? txLine(input.rouletteTx.signature, input.explorer)
    : { html: code("unconfirmed"), text: "`unconfirmed`" }
  const range = minutesLabel(input.snapshotMinMs, input.snapshotMaxMs)

  const text = [
    "✅ SNAPSHOT COMPLETE",
    "",
    DIVIDER,
    "",
    "🥇 Last Callout",
    "",
    `→ ${lastWallet.text}`,
    "",
    `${amount} sent`,
    "",
    "TX:",
    lastSig.text,
    "",
    DIVIDER,
    "",
    "🎰 Roulette Winner",
    "",
    `→ ${rouletteWallet.text}`,
    "",
    `${amount} sent`,
    "",
    "TX:",
    rouletteSig.text,
    "",
    DIVIDER,
    "",
    "💰 Total",
    total,
    "",
    "Next snapshot:",
    `⏳ Randomized between ${range}`,
  ].join("\n")

  const html = [
    `✅ ${bold("SNAPSHOT COMPLETE")}`,
    "",
    DIVIDER,
    "",
    `🥇 ${bold("Last Callout")}`,
    "",
    `→ ${lastWallet.html}`,
    "",
    `${escapeHtml(amount)} sent`,
    "",
    "TX:",
    lastSig.html,
    "",
    DIVIDER,
    "",
    `🎰 ${bold("Roulette Winner")}`,
    "",
    `→ ${rouletteWallet.html}`,
    "",
    `${escapeHtml(amount)} sent`,
    "",
    "TX:",
    rouletteSig.html,
    "",
    DIVIDER,
    "",
    `💰 ${bold("Total")}`,
    bold(total),
    "",
    "Next snapshot:",
    `⏳ Randomized between ${escapeHtml(range)}`,
  ].join("\n")

  return pair(html, text, "final")
}

export type BondSnippet = {
  percent: number
  solRaised: number
  solTarget: number
  bonded?: boolean
}

/** Append the bonding bar to a channel message. Hidden once the coin is bonded. */
export function withBondProgress(
  message: FormattedMessage,
  bond: BondSnippet | null | undefined,
): FormattedMessage {
  if (!bond || bond.bonded || bond.percent >= 100) return message
  const bar = progressBar(bond.percent)
  const status = `${bond.percent}%`
  const fill = `${formatSol(bond.solRaised)} / ${formatSol(bond.solTarget)} SOL`
  return {
    ...message,
    text: `${message.text}\n\n${bar} ${status} · ${fill}`,
    html: `${message.html}\n\n${code(bar)} ${bold(status)} · ${escapeHtml(fill)}`,
  }
}

export function qualifiedCaller(input: {
  callouts: Callout[]
  explorer?: ExplorerLinks
}): FormattedMessage {
  const list = input.callouts
  const count = list.length
  const names = list.map((c) => displayUsername(c.callerUsername))
  const maxShown = 40
  const shown = names.slice(0, maxShown)
  const overflow = names.length - shown.length

  const lines = [
    "✅ QUALIFIED",
    "",
    `Eligible this snapshot: ${count}`,
    "",
    ...shown,
  ]
  if (overflow > 0) lines.push(`…and ${overflow} more`)

  const htmlLines = [
    `✅ ${bold("QUALIFIED")}`,
    "",
    `Eligible this snapshot: ${bold(String(count))}`,
    "",
    ...shown.map((name) => escapeHtml(name)),
  ]
  if (overflow > 0) htmlLines.push(escapeHtml(`…and ${overflow} more`))

  return pair(htmlLines.join("\n"), lines.join("\n"), "qualified")
}

/** One lasting payout notice: winners, amounts, and sendout txs. */
export function snapshotPayout(input: {
  lastCallout: Callout
  rouletteWinner: Callout
  lastTx: DistributionTx | null
  rouletteTx: DistributionTx | null
  allocationAmount: number
  distributionToken: string
  snapshotMinMs: number
  snapshotMaxMs: number
  explorer?: ExplorerLinks
  pendingLabel?: string | null
}): FormattedMessage {
  const amount = formatAmount(input.allocationAmount, input.distributionToken)
  const total = formatAmount(input.allocationAmount * 2, input.distributionToken)
  const range = minutesLabel(input.snapshotMinMs, input.snapshotMaxMs)
  const lastBlock = formatWinnerBlock({
    title: "🥇 Last callout",
    titleHtml: `🥇 ${bold("Last callout")}`,
    callout: input.lastCallout,
    amount,
    tx: input.lastTx,
    explorer: input.explorer,
  })
  const rouletteBlock = formatWinnerBlock({
    title: "🎰 Roulette winner",
    titleHtml: `🎰 ${bold("Roulette winner")}`,
    callout: input.rouletteWinner,
    amount,
    tx: input.rouletteTx,
    explorer: input.explorer,
  })

  const footerText = input.pendingLabel
    ? [input.pendingLabel]
    : ["Next snapshot:", `⏳ Randomized between ${range}`]
  const footerHtml = input.pendingLabel
    ? [escapeHtml(input.pendingLabel)]
    : ["Next snapshot:", `⏳ Randomized between ${escapeHtml(range)}`]

  const text = [
    "💸 PAYOUT",
    "",
    DIVIDER,
    "",
    lastBlock.text,
    "",
    DIVIDER,
    "",
    rouletteBlock.text,
    "",
    DIVIDER,
    "",
    "💰 Total",
    total,
    "",
    ...footerText,
  ].join("\n")

  const html = [
    `💸 ${bold("PAYOUT")}`,
    "",
    DIVIDER,
    "",
    lastBlock.html,
    "",
    DIVIDER,
    "",
    rouletteBlock.html,
    "",
    DIVIDER,
    "",
    `💰 ${bold("Total")}`,
    bold(total),
    "",
    ...footerHtml,
  ].join("\n")

  return pair(html, text, "final")
}

function formatWinnerBlock(input: {
  title: string
  titleHtml: string
  callout: Callout
  amount: string
  tx: DistributionTx | null
  explorer?: ExplorerLinks
}): { html: string; text: string } {
  const caller = displayUsername(input.callout.callerUsername)
  const wallet = walletLine(input.callout.wallet, input.explorer)
  const tx = input.tx

  if (!tx) {
    return {
      text: [
        input.title,
        caller,
        `→ ${wallet.text}`,
        `${input.amount} · pending`,
      ].join("\n"),
      html: [
        input.titleHtml,
        escapeHtml(caller),
        `→ ${wallet.html}`,
        `${escapeHtml(input.amount)} · pending`,
      ].join("\n"),
    }
  }

  if (tx.status === "failed") {
    return {
      text: [
        input.title,
        caller,
        `→ ${wallet.text}`,
        `${input.amount} · failed`,
        tx.error ?? "Treasury send failed.",
      ].join("\n"),
      html: [
        input.titleHtml,
        escapeHtml(caller),
        `→ ${wallet.html}`,
        `${escapeHtml(input.amount)} · failed`,
        escapeHtml(tx.error ?? "Treasury send failed."),
      ].join("\n"),
    }
  }

  if (tx.status === "pending" || !tx.signature) {
    return {
      text: [
        input.title,
        caller,
        `→ ${wallet.text}`,
        `${input.amount} · sending…`,
      ].join("\n"),
      html: [
        input.titleHtml,
        escapeHtml(caller),
        `→ ${wallet.html}`,
        `${escapeHtml(input.amount)} · sending…`,
      ].join("\n"),
    }
  }

  const sig = txLine(tx.signature, input.explorer)
  return {
    text: [
      input.title,
      caller,
      `→ ${wallet.text}`,
      `${input.amount} sent`,
      "TX:",
      sig.text,
    ].join("\n"),
    html: [
      input.titleHtml,
      escapeHtml(caller),
      `→ ${wallet.html}`,
      `${escapeHtml(input.amount)} sent`,
      "TX:",
      sig.html,
    ].join("\n"),
  }
}

export function bondProgress(input: {
  percent: number
  solRaised: number
  solTarget: number
  eligibleCount: number
  minCallouts: number
  bonded?: boolean
}): FormattedMessage {
  const bar = progressBar(input.percent)
  const fill = `${formatSol(input.solRaised)} / ${formatSol(input.solTarget)} SOL`
  const status = input.bonded || input.percent >= 100 ? "BONDED" : `${input.percent}%`
  const text = [
    "🧬 BOND",
    "",
    `${bar} ${status}`,
    fill,
    "",
    `Bonus pool: ${input.eligibleCount} wallet${input.eligibleCount === 1 ? "" : "s"} (≥${input.minCallouts} callouts)`,
  ].join("\n")
  const html = [
    `🧬 ${bold("BOND")}`,
    "",
    `${code(bar)} ${bold(status)}`,
    escapeHtml(fill),
    "",
    `Bonus pool: ${bold(String(input.eligibleCount))} wallet${input.eligibleCount === 1 ? "" : "s"} (≥${input.minCallouts} callouts)`,
  ].join("\n")
  return pair(html, text, "bond")
}

export function migrationDetected(input: {
  eligibleCount: number
  holderCount?: number
  bonusAmount: number
  distributionToken: string
}): FormattedMessage {
  const amount = formatAmount(input.bonusAmount, input.distributionToken)
  const holders =
    input.holderCount == null
      ? `${input.eligibleCount} eligible wallets`
      : `${input.holderCount} still holding (${input.eligibleCount} eligible)`
  const text = [
    "🚀 BONDED",
    "",
    "Pump.fun curve complete.",
    holders,
    "",
    `Bonus: ${amount}`,
    "",
    "Selecting winner...",
  ].join("\n")
  const html = [
    `🚀 ${bold("BONDED")}`,
    "",
    "Pump.fun curve complete.",
    escapeHtml(holders),
    "",
    `Bonus: ${bold(amount)}`,
    "",
    "Selecting winner...",
  ].join("\n")
  return pair(html, text, "migration")
}

export function migrationSkipped(reason: string): FormattedMessage {
  const text = ["🚀 BONDING BONUS", "", "Skipped", "", reason].join("\n")
  const html = [`🚀 ${bold("BONDING BONUS")}`, "", bold("Skipped"), "", escapeHtml(reason)].join("\n")
  return pair(html, text, "migration")
}

export function migrationWinner(input: {
  callerUsername: string
  wallet: string
  calloutCount: number
  amount: number
  distributionToken: string
  explorer?: ExplorerLinks
}): FormattedMessage {
  const caller = displayUsername(input.callerUsername)
  const amount = formatAmount(input.amount, input.distributionToken)
  const wallet = walletLine(input.wallet, input.explorer)
  const text = [
    "🎯 BONDING BONUS",
    "",
    "SELECTED",
    "",
    caller,
    "",
    "Wallet:",
    wallet.text,
    "",
    `${input.calloutCount} accepted callouts`,
    "",
    "Allocation:",
    amount,
  ].join("\n")
  const html = [
    `🎯 ${bold("BONDING BONUS")}`,
    "",
    bold("SELECTED"),
    "",
    escapeHtml(caller),
    "",
    "Wallet:",
    wallet.html,
    "",
    `${input.calloutCount} accepted callouts`,
    "",
    "Allocation:",
    bold(amount),
  ].join("\n")
  return pair(html, text, "migration")
}

export function migrationFinal(input: {
  callerUsername: string
  wallet: string
  tx: DistributionTx
  amount: number
  distributionToken: string
  explorer?: ExplorerLinks
}): FormattedMessage {
  const caller = displayUsername(input.callerUsername)
  const amount = formatAmount(input.amount, input.distributionToken)
  const wallet = walletLine(input.wallet, input.explorer)
  const confirmed = formatConfirmedBlock(input.tx, input.explorer)
  const text = [
    "✅ BONDING BONUS SENT",
    "",
    caller,
    `→ ${wallet.text}`,
    "",
    `${amount} sent`,
    "",
    confirmed.text,
  ].join("\n")
  const html = [
    `✅ ${bold("BONDING BONUS SENT")}`,
    "",
    escapeHtml(caller),
    `→ ${wallet.html}`,
    "",
    `${escapeHtml(amount)} sent`,
    "",
    confirmed.html,
  ].join("\n")
  return pair(html, text, "final")
}

