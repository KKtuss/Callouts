import { readFileSync } from "node:fs"

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

async function api(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return response.json()
}

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

const limit = Number(process.argv[2] ?? 400)
let deleted = 0
let failed = 0
for (let id = tip; id > tip - limit && id > 0; id -= 1) {
  const result = await api("deleteMessage", { chat_id: chatId, message_id: id })
  if (result.ok) deleted += 1
  else failed += 1
}

console.log(JSON.stringify({ tip, deleted, failed, limit }))
