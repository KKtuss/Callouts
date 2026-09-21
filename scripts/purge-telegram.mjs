import { readFileSync } from "node:fs"

const envFile = process.env.ENV_FILE || ".env.local"
const env = Object.fromEntries(
  readFileSync(envFile, "utf8")
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
      value = value.replace(/\\r\\n/g, "").replace(/\r/g, "").trim()
      return [line.slice(0, i).trim(), value]
    }),
)

const token = env.TELEGRAM_BOT_TOKEN?.trim()
const chatId = env.TELEGRAM_CHANNEL_ID?.trim()
if (!token || !chatId) {
  console.error("missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID")
  process.exit(1)
}

async function api(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return response.json()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const me = await api("getMe", {})
const chat = await api("getChat", { chat_id: chatId })
const pinnedId = chat.result?.pinned_message?.message_id ?? null
/** Only the live pin is kept. Stale TELEGRAM_INTRO_MESSAGE_ID copies get deleted. */
const protectedIds = new Set(
  [pinnedId].filter((id) => Number.isFinite(id) && id > 0),
)

console.log(
  JSON.stringify({
    bot: me.result?.username,
    chat: chat.result?.title ?? chat.result?.username ?? chatId,
    type: chat.result?.type,
    protectedIds: [...protectedIds],
  }),
)

const probe = await api("sendMessage", {
  chat_id: chatId,
  text: "·",
  disable_notification: true,
  disable_web_page_preview: true,
})
if (!probe.ok) {
  console.error(probe)
  process.exit(1)
}

const tip = probe.result.message_id
await api("deleteMessage", { chat_id: chatId, message_id: tip })

const limit = Math.min(Number(process.argv[2] ?? tip), tip)
const reasons = new Map()
let deleted = 0
let failed = 0
let skipped = 0

for (let end = tip; end > tip - limit && end > 0; end -= 100) {
  const start = Math.max(1, end - 99, tip - limit + 1)
  const messageIds = []
  for (let id = end; id >= start; id -= 1) {
    if (protectedIds.has(id)) {
      skipped += 1
      continue
    }
    messageIds.push(id)
  }
  if (messageIds.length === 0) continue

  const result = await api("deleteMessages", { chat_id: chatId, message_ids: messageIds })
  if (result.ok) {
    deleted += messageIds.length
  } else {
    const batchReason = result.description ?? "batch failed"
    reasons.set(batchReason, (reasons.get(batchReason) ?? 0) + 1)
    for (const id of messageIds) {
      const one = await api("deleteMessage", { chat_id: chatId, message_id: id })
      if (one.ok) {
        deleted += 1
      } else {
        failed += 1
        const why = one.description ?? "failed"
        reasons.set(why, (reasons.get(why) ?? 0) + 1)
      }
      await sleep(20)
    }
  }
  await sleep(40)
}

console.log(
  JSON.stringify({
    tip,
    limit,
    deleted,
    failed,
    skipped,
    reasons: Object.fromEntries([...reasons.entries()].slice(0, 8)),
  }),
)
