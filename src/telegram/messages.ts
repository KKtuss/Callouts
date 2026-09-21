import { explorerAddressUrl, explorerTxUrl } from "@/lib/explorer"
import {
  DIVIDER,
  calloutSourceLabel,
  displayToken,
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
import { PRE_BOND_FOMO_NOTICE } from "@/lib/notices"
import type { Callout, ChannelMessageKind, DistributionTx } from "@/engine/types"

export { PRE_BOND_FOMO_NOTICE }

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

export const WAITING_FOR_SHILL = "Waiting for SHILL tech to be live..."

/** Permanent channel header — pinned, never purged. */
export function channelIntro(input: {
  tokenName: string | null
  ticker: string
  mint: string | null
  windowLabel: string
  siteUrl?: string | null
  telegramUrl?: string | null
  xUrl?: string | null
  pumpUrl?: string | null
  /** Pump curve still open — pin the FOMO wallet notice. */
  preBond?: boolean
  /** Drop the manifesto so the FOMO notice still fits a photo caption. */
  compact?: boolean
}): FormattedMessage {
  const mintShort = input.mint ? truncateWallet(input.mint, 4, 4) : null
  const waiting = !input.mint
  const preBondNotice = !waiting && input.preBond ? PRE_BOND_FOMO_NOTICE : null

  const links: { label: string; href: string }[] = []
  if (input.siteUrl) {
    const href = waiting ? input.siteUrl.split("#")[0] : input.siteUrl
    links.push({ label: "Website", href })
  }
  if (input.telegramUrl) links.push({ label: "Telegram", href: input.telegramUrl })
  if (input.xUrl) links.push({ label: "X", href: input.xUrl })
  if (!waiting) {
    if (input.pumpUrl) links.push({ label: "Pump.fun", href: input.pumpUrl })
    if (input.mint) {
      links.push({
        label: "Solscan",
        href: explorerAddressUrl(input.mint),
      })
    }
  }

  const manifesto = [
    "In a world where nothing matters more than being heard, why should the loud voices get nothing?",
    "",
    `SHILL reads the Pump.fun callout section, takes random snapshots, and pays the wallets doing the talking. Automatically, on-chain, every ${input.windowLabel}.`,
  ]
  const liveBody = [
    ...(input.compact ? [] : manifesto),
    ...(input.compact || !preBondNotice ? [] : [""]),
    ...(preBondNotice ? [preBondNotice] : []),
  ].join("\n")
  const bodyText = waiting ? WAITING_FOR_SHILL : liveBody

  const text = [
    "SHILL",
    "Speak up and take your money",
    "",
    DIVIDER,
    "",
    bodyText,
    "",
    DIVIDER,
    "",
    ...(waiting ? [] : [mintShort ? `Mint: ${mintShort}` : "Mint: not set yet", ""]),
    "Links",
    ...(links.length ? links.map((l) => `• ${l.label}: ${l.href}`) : ["• Coming soon"]),
  ].join("\n")

  const html = [
    bold("SHILL"),
    escapeHtml("Speak up and take your money"),
    "",
    DIVIDER,
    "",
    ...(waiting
      ? [escapeHtml(WAITING_FOR_SHILL)]
      : [
          ...(input.compact
            ? []
            : [
                escapeHtml(
                  "In a world where nothing matters more than being heard, why should the loud voices get nothing?",
                ),
                "",
                escapeHtml(
                  `SHILL reads the Pump.fun callout section, takes random snapshots, and pays the wallets doing the talking. Automatically, on-chain, every ${input.windowLabel}.`,
                ),
              ]),
          ...(input.compact || !preBondNotice ? [] : [""]),
          ...(preBondNotice ? [escapeHtml(preBondNotice)] : []),
        ]),
    "",
    DIVIDER,
    "",
    ...(waiting
      ? []
      : [
          mintShort
            ? `Mint: ${link(mintShort, explorerAddressUrl(input.mint!))}`
            : "Mint: not set yet",
          "",
        ]),
    bold("Links"),
    ...(links.length
      ? links.map((l) => `• ${link(l.label, l.href)}`)
      : ["• Coming soon"]),
  ].join("\n")

  return pair(html, text, "intro")
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
  const via = calloutSourceLabel(winner.source)
  const callerLine = via ? `${caller} · via ${via}` : caller
  const wallet = walletLine(winner.wallet, explorer)
  const text = [
    "🎰 ROULETTE",
    "",
    "🎯 SELECTED",
    "",
    "Caller:",
    callerLine,
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
    escapeHtml(callerLine),
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
  const lastSource = calloutSourceLabel(input.lastCallout.source)
  const rouletteSource = calloutSourceLabel(input.rouletteWinner.source)
  const lastCallerLine = lastSource
    ? `${displayUsername(input.lastCallout.callerUsername)} · via ${lastSource}`
    : displayUsername(input.lastCallout.callerUsername)
  const rouletteCallerLine = rouletteSource
    ? `${displayUsername(input.rouletteWinner.callerUsername)} · via ${rouletteSource}`
    : displayUsername(input.rouletteWinner.callerUsername)

  const text = [
    "📸 SNAPSHOT COMPLETE",
    "",
    DIVIDER,
    "",
    "🥇 LAST CALLOUT",
    "",
    "Caller:",
    lastCallerLine,
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
    rouletteCallerLine,
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
    escapeHtml(lastCallerLine),
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
    escapeHtml(rouletteCallerLine),
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

/** FOMO wallet instruction — on every channel post while the mint is pre-bond. */
export function withPreBondFomoNotice(
  message: FormattedMessage,
  preBond: boolean | null | undefined,
): FormattedMessage {
  if (!preBond) return message
  if (message.text.includes(PRE_BOND_FOMO_NOTICE)) return message
  return {
    ...message,
    text: `${message.text}\n\n${PRE_BOND_FOMO_NOTICE}`,
    html: `${message.html}\n\n${escapeHtml(PRE_BOND_FOMO_NOTICE)}`,
  }
}

export function qualifiedCaller(input: {
  callouts: Callout[]
  latest?: Callout
  explorer?: ExplorerLinks
}): FormattedMessage {
  const list = input.callouts
  const count = list.length
  const latest = input.latest ?? list[list.length - 1] ?? null
  const latestName = latest ? displayUsername(latest.callerUsername) : null
  const latestVia = latest ? calloutSourceLabel(latest.source) : null
  const latestThesis = latest?.thesis?.trim() || ""
  const latestWallet = latest ? walletLine(latest.wallet, input.explorer) : null
  const maxShown = 40
  const shown = list.slice(0, maxShown).map((row) => {
    const name = displayUsername(row.callerUsername)
    const via = calloutSourceLabel(row.source)
    return via ? `${name} · ${via}` : name
  })
  const overflow = list.length - shown.length

  const lines = [
    "🗣️ QUALIFIED",
    "",
    ...(latestName ? [latestName] : []),
    ...(latestVia ? [`via ${latestVia}`] : []),
    ...(latestWallet ? [latestWallet.text] : []),
    ...(latestThesis ? [latestThesis] : []),
    "",
    `Eligible this snapshot: ${count}`,
    "",
    ...shown,
  ]
  if (overflow > 0) lines.push(`…and ${overflow} more`)

  const htmlLines = [
    `🗣️ ${bold("QUALIFIED")}`,
    "",
    ...(latestName ? [escapeHtml(latestName)] : []),
    ...(latestVia ? [escapeHtml(`via ${latestVia}`)] : []),
    ...(latestWallet ? [latestWallet.html] : []),
    ...(latestThesis ? [escapeHtml(latestThesis)] : []),
    "",
    `Eligible this snapshot: ${bold(String(count))}`,
    "",
    ...shown.map((row) => escapeHtml(row)),
  ]
  if (overflow > 0) htmlLines.push(escapeHtml(`…and ${overflow} more`))

  return pair(htmlLines.join("\n"), lines.join("\n"), "qualified")
}

export function snapshotHeading(number: number): { text: string; html: string } {
  const n = Number.isFinite(number) && number > 0 ? Math.floor(number) : 1
  const label = `SNAPSHOT #${n}`
  return { text: `📸 ${label}`, html: `📸 ${bold(label)}` }
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
  snapshotNumber: number
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

  const heading = snapshotHeading(input.snapshotNumber)
  const text = [
    heading.text,
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
    heading.html,
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
  const via = calloutSourceLabel(input.callout.source)
  const callerLine = via ? `${caller} · via ${via}` : caller
  const wallet = walletLine(input.callout.wallet, input.explorer)
  const tx = input.tx

  if (!tx) {
    return {
      text: [
        input.title,
        callerLine,
        `→ ${wallet.text}`,
        `${input.amount} · pending`,
      ].join("\n"),
      html: [
        input.titleHtml,
        escapeHtml(callerLine),
        `→ ${wallet.html}`,
        `${escapeHtml(input.amount)} · pending`,
      ].join("\n"),
    }
  }

  if (tx.status === "failed") {
    return {
      text: [
        input.title,
        callerLine,
        `→ ${wallet.text}`,
        `${input.amount} · failed`,
        tx.error ?? "Treasury send failed.",
      ].join("\n"),
      html: [
        input.titleHtml,
        escapeHtml(callerLine),
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
        callerLine,
        `→ ${wallet.text}`,
        `${input.amount} · sending…`,
      ].join("\n"),
      html: [
        input.titleHtml,
        escapeHtml(callerLine),
        `→ ${wallet.html}`,
        `${escapeHtml(input.amount)} · sending…`,
      ].join("\n"),
    }
  }

  const sig = txLine(tx.signature, input.explorer)
  return {
    text: [
      input.title,
      callerLine,
      `→ ${wallet.text}`,
      `${input.amount} sent`,
      "TX:",
      sig.text,
    ].join("\n"),
    html: [
      input.titleHtml,
      escapeHtml(callerLine),
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
  winnerCount: number
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
    `Remaining supply: ${amount}`,
    `Lottery: ${input.winnerCount} winners`,
    "",
    "Selecting winners...",
  ].join("\n")
  const html = [
    `🚀 ${bold("BONDED")}`,
    "",
    "Pump.fun curve complete.",
    escapeHtml(holders),
    "",
    `Remaining supply: ${bold(amount)}`,
    `Lottery: ${bold(String(input.winnerCount))} winners`,
    "",
    "Selecting winners...",
  ].join("\n")
  return pair(html, text, "migration")
}

export function migrationSkipped(reason: string): FormattedMessage {
  const text = ["🚀 BONDING LOTTERY", "", "Skipped", "", reason].join("\n")
  const html = [`🚀 ${bold("BONDING LOTTERY")}`, "", bold("Skipped"), "", escapeHtml(reason)].join("\n")
  return pair(html, text, "migration")
}

export function migrationWinner(input: {
  winners: Array<{
    callerUsername: string
    wallet: string
    calloutCount: number
    amount: number
  }>
  distributionToken: string
  explorer?: ExplorerLinks
}): FormattedMessage {
  const lines = input.winners.map((row, i) => {
    const caller = displayUsername(row.callerUsername)
    const amount = formatAmount(row.amount, input.distributionToken)
    const wallet = walletLine(row.wallet, input.explorer)
    return {
      text: `${i + 1}. ${caller} · ${amount}\n   ${wallet.text} · ${row.calloutCount} callouts`,
      html: `${i + 1}. ${escapeHtml(caller)} · ${bold(amount)}<br/>   ${wallet.html} · ${row.calloutCount} callouts`,
    }
  })
  const text = ["🎯 BONDING LOTTERY", "", "SELECTED", "", ...lines.map((l) => l.text)].join("\n\n")
  const html = [
    `🎯 ${bold("BONDING LOTTERY")}`,
    "",
    bold("SELECTED"),
    "",
    ...lines.map((l) => l.html),
  ].join("\n")
  return pair(html, text, "migration")
}

export function migrationFinal(input: {
  winners: Array<{
    callerUsername: string
    wallet: string
    amount: number
    tx: DistributionTx
  }>
  distributionToken: string
  explorer?: ExplorerLinks
}): FormattedMessage {
  const lines = input.winners.map((row, i) => {
    const caller = displayUsername(row.callerUsername)
    const amount = formatAmount(row.amount, input.distributionToken)
    const wallet = walletLine(row.wallet, input.explorer)
    const confirmed = formatConfirmedBlock(row.tx, input.explorer)
    return {
      text: `${i + 1}. ${caller} → ${wallet.text}\n   ${amount}\n   ${confirmed.text}`,
      html: `${i + 1}. ${escapeHtml(caller)} → ${wallet.html}<br/>   ${escapeHtml(amount)}<br/>   ${confirmed.html}`,
    }
  })
  const text = ["✅ BONDING LOTTERY SENT", "", ...lines.map((l) => l.text)].join("\n\n")
  const html = [`✅ ${bold("BONDING LOTTERY SENT")}`, "", ...lines.map((l) => l.html)].join("\n")
  return pair(html, text, "final")
}

