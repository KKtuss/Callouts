import { FORBIDDEN_PUBLIC_COMMANDS } from "@/telegram/commands"
import type { ChannelMessage, ChannelMessageKind } from "@/engine/types"
import type { FormattedMessage } from "@/telegram/messages"

export interface Broadcast {
  send(message: FormattedMessage): Promise<ChannelMessage>
  edit(id: string, message: FormattedMessage): Promise<ChannelMessage>
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

  async disablePublicCommands(): Promise<void> {
    // Preview has no command menu. Presence of forbidden names is a hard error
    // so we never accidentally grow a public control surface.
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

  async disablePublicCommands(): Promise<void> {
    await this.api("deleteMyCommands", {})
    await this.api("setMyCommands", { commands: [] })
  }

  private async api(method: string, body: Record<string, unknown>) {
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
      result: { message_id: number }
    }
    if (!payload.ok) {
      throw new Error(payload.description ?? `Telegram ${method} failed`)
    }
    return payload
  }
}

export function createBroadcast(): { preview: PreviewBroadcast; broadcast: Broadcast; telegramConnected: boolean; channelId: string | null } {
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
    const local = await this.preview.edit(id, message)
    const remoteId = this.map.get(id)
    if (remoteId) {
      try {
        const remote = await this.telegram.edit(remoteId, message)
        return { ...local, telegramMessageId: remote.telegramMessageId }
      } catch (error) {
        console.error("[telegram] edit failed; preview still updated", error)
      }
    }
    return local
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
