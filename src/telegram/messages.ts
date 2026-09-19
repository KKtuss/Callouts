import { explorerAddressUrl, explorerTxUrl } from "@/lib/explorer"
import {
  DIVIDER,
  displayToken,
  displayUsername,
  escapeHtml,
  formatAmount,
  formatSnapshotWindow,
  minutesLabel,
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

export function rouletteSpin(token: string): FormattedMessage {
  const ticker = displayToken(token)
  const text = ["🎰 ROULETTE", "", `🔄 ${ticker}`].join("\n")
  const html = [`🎰 ${bold("ROULETTE")}`, "", `🔄 ${bold(ticker)}`].join("\n")
  return pair(html, text, "roulette")
}

export function rouletteSelected(
  winner: Callout,
  explorer?: ExplorerLinks,
): FormattedMessage {
  const ticker = displayToken(winner.token)
  const caller = displayUsername(winner.callerUsername)
  const wallet = walletLine(winner.wallet, explorer)
  const text = [
    "🎰 ROULETTE",
    "",
    "🎯 SELECTED",
    "",
    ticker,
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
    bold(ticker),
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
    displayToken(input.lastCallout.token),
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
    displayToken(input.rouletteWinner.token),
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
    bold(displayToken(input.lastCallout.token)),
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
    bold(displayToken(input.rouletteWinner.token)),
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
    displayToken(input.lastCallout.token),
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
    displayToken(input.rouletteWinner.token),
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
    bold(displayToken(input.lastCallout.token)),
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
    bold(displayToken(input.rouletteWinner.token)),
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

