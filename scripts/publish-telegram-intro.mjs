/**
 * Publish (or refresh) the permanent pinned SHILL channel intro.
 * Usage: node scripts/publish-telegram-intro.mjs
 */
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const i = line.indexOf("=")
      let value = line.slice(i + 1)
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      return [line.slice(0, i).trim(), value]
    }),
)

const token = env.TELEGRAM_BOT_TOKEN?.trim()
const chatId = env.TELEGRAM_CHANNEL_ID?.trim()
if (!token || !chatId) {
  console.error("missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID")
  process.exit(1)
}

async function apiJson(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return response.json()
}

const ticker = (env.CALLOUT_TOKEN || env.DISTRIBUTION_TOKEN || "SHILL").replace(/^\$/, "")
const name = env.CALLOUT_NAME?.trim() || null
const mint = env.CALLOUT_MINT?.trim() || null
const siteUrl = env.NEXT_PUBLIC_SITE_URL?.trim() || "https://callout-beta.vercel.app"
const telegramUrl = env.NEXT_PUBLIC_TELEGRAM_URL?.trim() || null
const xUrl = env.NEXT_PUBLIC_X_URL?.trim() || null
const windowLabel = "5–15 minutes"

const tokenLine = name ? `${name} ($${ticker})` : `$${ticker}`
const mintShort = mint ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : null

const links = []
if (siteUrl) links.push(`• <a href="${siteUrl}">Website</a>`)
if (telegramUrl) links.push(`• <a href="${telegramUrl}">Telegram</a>`)
if (xUrl) links.push(`• <a href="${xUrl}">X</a>`)
if (mint) links.push(`• <a href="https://pump.fun/coin/${mint}">Pump.fun</a>`)
if (mint) links.push(`• <a href="https://solscan.io/account/${mint}">Solscan</a>`)
if (links.length === 0) links.push("• Coming soon")

const caption = [
  "<b>SHILL</b>",
  "Get some money where your mouth is.",
  "",
  "────────────────",
  "",
  `Token: <b>${tokenLine.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</b>`,
  mintShort
    ? `Mint: <a href="https://solscan.io/account/${mint}">${mintShort}</a>`
    : "Mint: not set yet",
  "",
  "────────────────",
  "",
  "In a world where nothing matters more than being heard, why should the loud voices get nothing?",
  "",
  `SHILL reads the Pump.fun callout section, takes random snapshots, and pays the wallets doing the talking. Automatically, on-chain, every ${windowLabel}.`,
  "",
  "────────────────",
  "",
  "<b>Links</b>",
  ...links,
].join("\n")

const chat = await apiJson("getChat", { chat_id: chatId })
const pinnedId = chat.result?.pinned_message?.message_id

if (pinnedId) {
  const edited = await apiJson("editMessageCaption", {
    chat_id: chatId,
    message_id: pinnedId,
    caption,
    parse_mode: "HTML",
  })
  if (edited.ok) {
    console.log(JSON.stringify({ action: "edited-pinned", message_id: pinnedId }))
    process.exit(0)
  }
}

const banner =
  [path.join(process.cwd(), "public", "brand", "logo.png"), path.join(process.cwd(), "public", "brand", "shill-mark.png")].find(
    (p) => existsSync(p),
  ) ?? null

let messageId
if (banner) {
  const form = new FormData()
  form.append("chat_id", chatId)
  form.append("caption", caption)
  form.append("parse_mode", "HTML")
  form.append("photo", new Blob([readFileSync(banner)], { type: "image/png" }), path.basename(banner))
  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    body: form,
  })
  const payload = await response.json()
  if (!payload.ok) {
    console.error(payload)
    process.exit(1)
  }
  messageId = payload.result.message_id
} else {
  const sent = await apiJson("sendMessage", {
    chat_id: chatId,
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  })
  if (!sent.ok) {
    console.error(sent)
    process.exit(1)
  }
  messageId = sent.result.message_id
}

await apiJson("pinChatMessage", {
  chat_id: chatId,
  message_id: messageId,
  disable_notification: true,
})

console.log(
  JSON.stringify({
    action: "sent-and-pinned",
    message_id: messageId,
    tip: `Set TELEGRAM_INTRO_MESSAGE_ID=${messageId} on Vercel to protect across cold starts`,
  }),
)
