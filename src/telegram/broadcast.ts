import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { FORBIDDEN_PUBLIC_COMMANDS } from "@/telegram/commands"
import type { ChannelMessage, ChannelMessageKind } from "@/engine/types"
import type { FormattedMessage } from "@/telegram/messages"

export type ChannelIntroPayload = {
  tokenName: string | null
  ticker: string
  mint: string | null
  windowLabel: string
  siteUrl?: string | null
  telegramUrl?: string | null
  xUrl?: string | null
  pumpUrl?: string | null
  /** Absolute or cwd-relative path to the banner image. */
  bannerPath?: string
}

export type EnsureIntroOptions = {
  createIfMissing?: boolean
  /** Edit the existing pin even when the payload has no mint (idle / waiting). */
  allowClearMint?: boolean
}

export interface Broadcast {
  send(message: FormattedMessage): Promise<ChannelMessage>
  edit(id: string, message: FormattedMessage): Promise<ChannelMessage>
  delete(id: string): Promise<void>
  /** Drop tracked messages. Optionally also delete recent Telegram channel posts. */
  clear(options?: { purgeTelegram?: number }): Promise<void>
  /** Permanent pinned intro (banner + hero). Survives mint resets / purges. */
  ensureIntro(
    payload: ChannelIntroPayload,
    message: FormattedMessage,
    options?: EnsureIntroOptions,
  ): Promise<ChannelMessage | null>
  disablePublicCommands(): Promise<void>
  getMessages(): ChannelMessage[]
}

type Listener = (messages: ChannelMessage[]) => void

function newId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * In-process channel. This is the always-on public display surface used by the
 * private admin preview. Optional Telegram delivery is layered on top.
 */
export class PreviewBroadcast implements Broadcast {
  private messages: ChannelMessage[] = []
  private listeners = new Set<Listener>()
  private introId: string | null = null

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getMessages(): ChannelMessage[] {
    return this.messages.map((message) => ({ ...message }))
  }

  async send(message: FormattedMessage): Promise<ChannelMessage> {
    const now = new Date().toISOString()
    const stored: ChannelMessage = {
      id: newId(),
      telegramMessageId: null,
      kind: message.kind,
      html: message.html,
      text: message.text,
      createdAt: now,
      editedAt: null,
      editCount: 0,
    }
    this.messages = [...this.messages, stored].slice(-80)
    this.emit()
    return { ...stored }
  }

  async edit(id: string, message: FormattedMessage): Promise<ChannelMessage> {
    const index = this.messages.findIndex((item) => item.id === id)
    if (index === -1) {
      throw new Error(`Cannot edit unknown channel message ${id}`)
    }
    const current = this.messages[index]
    const updated: ChannelMessage = {
      ...current,
      kind: message.kind,
      html: message.html,
      text: message.text,
      editedAt: new Date().toISOString(),
      editCount: current.editCount + 1,
    }
    this.messages = this.messages.map((item, i) => (i === index ? updated : item))
    this.emit()
    return { ...updated }
  }

  async delete(id: string): Promise<void> {
    if (id === this.introId) return
    const numeric = Number(id)
    const before = this.messages.length
    this.messages = this.messages.filter((item) => {
      if (item.id === id) return false
      if (Number.isFinite(numeric) && item.telegramMessageId === numeric) return false
      return true
    })
    if (this.messages.length !== before) this.emit()
  }

  async clear(_options?: { purgeTelegram?: number }): Promise<void> {
    const intro = this.introId
      ? this.messages.find((item) => item.id === this.introId) ?? null
      : null
    this.messages = intro ? [intro] : []
    this.emit()
  }

  async ensureIntro(
    payload: ChannelIntroPayload,
    message: FormattedMessage,
    options?: EnsureIntroOptions,
  ): Promise<ChannelMessage | null> {
    if (!payload.mint && this.introId && !options?.allowClearMint) {
      return this.messages.find((item) => item.id === this.introId) ?? null
    }
    if (this.introId) {
      try {
        return await this.edit(this.introId, message)
      } catch {
        this.introId = null
      }
    }
    const existing = this.messages.find((item) => item.kind === "intro")
    if (existing) {
      this.introId = existing.id
      if (!payload.mint) return existing
      return this.edit(existing.id, message)
    }
    if (options?.createIfMissing === false) return existing ?? null
    const sent = await this.send(message)
    this.introId = sent.id
    return sent
  }

  async disablePublicCommands(): Promise<void> {
    for (const command of FORBIDDEN_PUBLIC_COMMANDS) {
      if (command.length === 0) {
        throw new Error("Invalid forbidden command list")
      }
    }
  }

  private emit() {
    const snapshot = this.getMessages()
    for (const listener of this.listeners) listener(snapshot)
  }
}

export class TelegramBroadcast implements Broadcast {
  private local = new Map<string, ChannelMessage>()
  /** Telegram message ids that must never be purged (pinned intro). */
  private protectedIds = new Set<number>()
  private pinnedId: number | null = null

  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}

  getMessages(): ChannelMessage[] {
    return [...this.local.values()]
  }

  async send(message: FormattedMessage): Promise<ChannelMessage> {
    const payload = await this.api("sendMessage", {
      chat_id: this.chatId,
      text: message.html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: false,
    })
    const stored: ChannelMessage = {
      id: String(payload.result.message_id),
      telegramMessageId: payload.result.message_id,
      kind: message.kind,
      html: message.html,
      text: message.text,
      createdAt: new Date().toISOString(),
      editedAt: null,
      editCount: 0,
    }
    this.local.set(stored.id, stored)
    return stored
  }

  async edit(id: string, message: FormattedMessage): Promise<ChannelMessage> {
    const current = this.local.get(id)
    const telegramId = current?.telegramMessageId ?? Number(id)
    await this.api("editMessageText", {
      chat_id: this.chatId,
      message_id: telegramId,
      text: message.html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    })
    const updated: ChannelMessage = {
      id,
      telegramMessageId: telegramId,
      kind: message.kind as ChannelMessageKind,
      html: message.html,
      text: message.text,
      createdAt: current?.createdAt ?? new Date().toISOString(),
      editedAt: new Date().toISOString(),
      editCount: (current?.editCount ?? 0) + 1,
    }
    this.local.set(id, updated)
    return updated
  }

  async delete(id: string): Promise<void> {
    const current = this.local.get(id)
    const telegramId = current?.telegramMessageId ?? Number(id)
    if (!Number.isFinite(telegramId)) {
      this.local.delete(id)
      return
    }
    if (this.protectedIds.has(telegramId)) return
    try {
      await this.api("deleteMessage", {
        chat_id: this.chatId,
        message_id: telegramId,
      })
    } finally {
      this.local.delete(id)
    }
  }

  async clear(options?: { purgeTelegram?: number }): Promise<void> {
    const tracked = [...this.local.entries()]
    for (const [id, message] of tracked) {
      if (message.telegramMessageId && this.protectedIds.has(message.telegramMessageId)) continue
      try {
        await this.delete(id)
      } catch {
        this.local.delete(id)
      }
    }
    const purge = options?.purgeTelegram ?? 0
    if (purge > 0) await this.purgeRecentChannelPosts(purge)
  }

  async ensureIntro(
    payload: ChannelIntroPayload,
    message: FormattedMessage,
    options?: EnsureIntroOptions,
  ): Promise<ChannelMessage | null> {
    await this.refreshProtectedFromPin()

    const envId = Number(process.env.TELEGRAM_INTRO_MESSAGE_ID ?? "")
    const existingId =
      this.pinnedId ??
      (Number.isFinite(envId) && envId > 0 ? envId : null)
    if (existingId) {
      // A pin (or known intro id) means never send a second banner — even if
      // edit fails. Cold starts with mint=null must not blank a live pin;
      // idle/waiting publishes pass allowClearMint to swap in the waiting copy.
      if (payload.mint || options?.allowClearMint) {
        const edited = await this.tryEditIntro(existingId, message)
        if (edited) return edited
      }
      return {
        id: String(existingId),
        telegramMessageId: existingId,
        kind: "intro",
        html: message.html,
        text: message.text,
        createdAt: new Date().toISOString(),
        editedAt: null,
        editCount: 0,
      }
    }

    if (options?.createIfMissing === false) return null

    const previousPin = this.pinnedId
    const banner = resolveBannerPath(payload.bannerPath)
    const sent = banner
      ? await this.sendPhoto(banner, message)
      : await this.send(message)

    const telegramId = sent.telegramMessageId
    if (telegramId) {
      this.pinnedId = telegramId
      this.protectedIds = new Set([telegramId])
      try {
        await this.api("pinChatMessage", {
          chat_id: this.chatId,
          message_id: telegramId,
          disable_notification: true,
        })
      } catch (error) {
        console.error("[telegram] failed to pin intro", error)
      }
      if (previousPin && previousPin !== telegramId) {
        try {
          await this.api("deleteMessage", {
            chat_id: this.chatId,
            message_id: previousPin,
          })
        } catch {
          /* old banner may already be gone */
        }
      }
    }
    return sent
  }

  private async tryEditIntro(
    telegramId: number,
    message: FormattedMessage,
  ): Promise<ChannelMessage | null> {
    try {
      await this.api("editMessageCaption", {
        chat_id: this.chatId,
        message_id: telegramId,
        caption: message.html,
        parse_mode: "HTML",
      })
    } catch {
      try {
        await this.api("editMessageText", {
          chat_id: this.chatId,
          message_id: telegramId,
          text: message.html,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        })
      } catch (error) {
        console.error("[telegram] failed to refresh intro", error)
        return null
      }
    }
    const updated: ChannelMessage = {
      id: String(telegramId),
      telegramMessageId: telegramId,
      kind: "intro",
      html: message.html,
      text: message.text,
      createdAt: new Date().toISOString(),
      editedAt: new Date().toISOString(),
      editCount: 1,
    }
    this.local.set(updated.id, updated)
    this.protectedIds.add(telegramId)
    return updated
  }

  private async sendPhoto(filePath: string, message: FormattedMessage): Promise<ChannelMessage> {
    const bytes = readFileSync(filePath)
    const form = new FormData()
    form.append("chat_id", this.chatId)
    form.append("caption", message.html)
    form.append("parse_mode", "HTML")
    form.append("disable_notification", "false")
    form.append("photo", new Blob([bytes], { type: "image/png" }), path.basename(filePath))

    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendPhoto`, {
      method: "POST",
      body: form,
    })
    const payload = (await response.json()) as {
      ok: boolean
      description?: string
      result: { message_id: number }
    }
    if (!payload.ok) {
      throw new Error(payload.description ?? "Telegram sendPhoto failed")
    }
    const stored: ChannelMessage = {
      id: String(payload.result.message_id),
      telegramMessageId: payload.result.message_id,
      kind: message.kind,
      html: message.html,
      text: message.text,
      createdAt: new Date().toISOString(),
      editedAt: null,
      editCount: 0,
    }
    this.local.set(stored.id, stored)
    return stored
  }

  private async refreshProtectedFromPin() {
    this.protectedIds = new Set()
    this.pinnedId = null
    try {
      const chat = await this.api("getChat", { chat_id: this.chatId })
      const pinnedId = (chat.result as { pinned_message?: { message_id?: number } })?.pinned_message
        ?.message_id
      if (pinnedId) {
        this.pinnedId = pinnedId
        this.protectedIds.add(pinnedId)
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Telegram has no “list my posts” API. Probe the latest message id, then
   * walk backward deleting what we can (bot-authored channel posts).
   * Protected / pinned intro ids are skipped.
   */
  private async purgeRecentChannelPosts(count: number) {
    await this.refreshProtectedFromPin()
    const limit = Math.max(0, Math.min(Math.floor(count), 5_000))
    if (limit === 0) return

    let tip = 0
    try {
      const probe = await this.api("sendMessage", {
        chat_id: this.chatId,
        text: "·",
        disable_notification: true,
        disable_web_page_preview: true,
      })
      tip = probe.result.message_id
      try {
        await this.api("deleteMessage", { chat_id: this.chatId, message_id: tip })
      } catch {
        /* tip may already be gone */
      }
    } catch (error) {
      console.error("[telegram] channel purge probe failed", error)
      return
    }

    // Collect ids to delete (skip protected/pinned).
    const ids: number[] = []
    for (let id = tip; id > tip - limit && id > 0; id -= 1) {
      if (!this.protectedIds.has(id)) ids.push(id)
    }

    // Batch-delete in chunks of 100 (Telegram deleteMessages, Bot API 6.8+).
    // Falls back to serial deleteMessage if the batch call fails.
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      try {
        await this.api("deleteMessages", { chat_id: this.chatId, message_ids: chunk })
      } catch {
        for (const id of chunk) {
          try {
            await this.api("deleteMessage", { chat_id: this.chatId, message_id: id })
          } catch { /* not ours / already deleted / too old */ }
        }
      }
    }
  }

  async disablePublicCommands(): Promise<void> {
    await this.api("deleteMyCommands", {})
    await this.api("setMyCommands", { commands: [] })
  }

  private async api(
    method: string,
    body: Record<string, unknown>,
    attempt = 0,
  ): Promise<{ ok: boolean; description?: string; result: { message_id: number } }> {
    if (FORBIDDEN_PUBLIC_COMMANDS.some((command) => method.toLowerCase().includes(command))) {
      throw new Error("Refusing Telegram method that looks like a public command handler")
    }

    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const payload = (await response.json()) as {
      ok: boolean
      description?: string
      parameters?: { retry_after?: number }
      result: { message_id: number }
    }
    if (!payload.ok) {
      const retryAfter = Number(payload.parameters?.retry_after)
      if (attempt < 4 && Number.isFinite(retryAfter) && retryAfter > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(20_000, retryAfter * 1000)))
        return this.api(method, body, attempt + 1)
      }
      throw new Error(payload.description ?? `Telegram ${method} failed`)
    }
    return payload
  }
}

function resolveBannerPath(explicit?: string): string | null {
  const candidates = [
    explicit,
    path.join(process.cwd(), "public", "brand", "logo.png"),
    path.join(process.cwd(), "public", "brand", "shill-mark.png"),
  ].filter(Boolean) as string[]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function createBroadcast(): {
  preview: PreviewBroadcast
  broadcast: Broadcast
  telegramConnected: boolean
  channelId: string | null
} {
  const preview = new PreviewBroadcast()
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const channelId = process.env.TELEGRAM_CHANNEL_ID?.trim()
  if (token && channelId) {
    const telegram = new TelegramBroadcast(token, channelId)
    return {
      preview,
      broadcast: new DualBroadcast(preview, telegram),
      telegramConnected: true,
      channelId,
    }
  }
  return { preview, broadcast: preview, telegramConnected: false, channelId: null }
}

/**
 * Preview is source-of-truth for the admin UI. Telegram is a fan-out copy.
 * Edits always target the preview id; Telegram uses the mirrored message.
 */
class DualBroadcast implements Broadcast {
  private map = new Map<string, string>()

  constructor(
    private readonly preview: PreviewBroadcast,
    private readonly telegram: TelegramBroadcast,
  ) {}

  getMessages(): ChannelMessage[] {
    return this.preview.getMessages()
  }

  async send(message: FormattedMessage): Promise<ChannelMessage> {
    const local = await this.preview.send(message)
    try {
      const remote = await this.telegram.send(message)
      this.map.set(local.id, remote.id)
      return { ...local, telegramMessageId: remote.telegramMessageId }
    } catch (error) {
      console.error("[telegram] send failed; preview still published", error)
      return local
    }
  }

  async edit(id: string, message: FormattedMessage): Promise<ChannelMessage> {
    const hasLocal = this.preview.getMessages().some((item) => item.id === id)
    if (hasLocal) {
      const local = await this.preview.edit(id, message)
      const remoteId = this.map.get(id)
      if (remoteId) {
        let lastError: unknown
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            const remote = await this.telegram.edit(remoteId, message)
            return { ...local, telegramMessageId: remote.telegramMessageId }
          } catch (error) {
            lastError = error
            await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt))
          }
        }
        console.error("[telegram] edit failed; preview still updated", lastError)
      }
      return local
    }

    if (/^\d+$/.test(id)) {
      const remote = await this.telegram.edit(id, message)
      const local = await this.preview.send(message)
      this.map.set(local.id, remote.id)
      return { ...local, telegramMessageId: remote.telegramMessageId }
    }

    return this.preview.edit(id, message)
  }

  async delete(id: string): Promise<void> {
    let previewId = id
    let remoteId = this.map.get(id) ?? (/^\d+$/.test(id) ? id : null)
    if (!this.map.has(id) && /^\d+$/.test(id)) {
      for (const [local, remote] of this.map) {
        if (remote === id) {
          previewId = local
          remoteId = remote
          break
        }
      }
    }
    try {
      await this.preview.delete(previewId)
    } catch {
      /* preview may not know a restored telegram id */
    }
    this.map.delete(previewId)
    this.map.delete(id)
    if (remoteId) {
      try {
        await this.telegram.delete(remoteId)
      } catch (error) {
        console.error("[telegram] delete failed; preview still removed", error)
      }
    }
  }

  async clear(options?: { purgeTelegram?: number }): Promise<void> {
    await this.preview.clear()
    // Keep map entries that still exist in preview (intro).
    const keep = new Set(this.preview.getMessages().map((item) => item.id))
    for (const key of [...this.map.keys()]) {
      if (!keep.has(key)) this.map.delete(key)
    }
    try {
      await this.telegram.clear(options)
    } catch (error) {
      console.error("[telegram] clear failed; preview still wiped", error)
    }
  }

  async ensureIntro(
    payload: ChannelIntroPayload,
    message: FormattedMessage,
    options?: EnsureIntroOptions,
  ): Promise<ChannelMessage | null> {
    const local = await this.preview.ensureIntro(payload, message, options)
    try {
      const remote = await this.telegram.ensureIntro(payload, message, options)
      if (local && remote) {
        this.map.set(local.id, remote.id)
        return { ...local, telegramMessageId: remote.telegramMessageId }
      }
      return local ?? remote
    } catch (error) {
      console.error("[telegram] intro failed; preview still published", error)
      return local
    }
  }

  async disablePublicCommands(): Promise<void> {
    await this.preview.disablePublicCommands()
    try {
      await this.telegram.disablePublicCommands()
    } catch (error) {
      console.error("[telegram] failed to clear bot commands", error)
    }
  }
}
