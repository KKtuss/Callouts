"use client"

import { useEffect, useRef } from "react"
import type { ChannelMessage } from "@/engine/types"
import { formatClockIso, displayToken } from "@/lib/format"
import { cn } from "@/lib/utils"

function renderText(text: string) {
  const lines = text.split("\n")
  return lines.map((line, index) => (
    <span key={`${index}-${line}`} className="block min-h-[1em]">
      {line.split(/(`[^`]+`)/g).map((chunk, i) => {
        if (chunk.startsWith("`") && chunk.endsWith("`")) {
          return (
            <code
              key={i}
              className="rounded bg-black/30 px-1 py-0.5 font-mono text-[12px] text-[#6ab3f3]"
            >
              {chunk.slice(1, -1)}
            </code>
          )
        }
        if (/^[📸🎰⏳✅🥇💰🔄🎯❌🧬🚀]/.test(chunk)) {
          return (
            <span key={i} className="font-medium text-white">
              {chunk}
            </span>
          )
        }
        return <span key={i}>{chunk}</span>
      })}
    </span>
  ))
}

export function ChannelPreview({
  messages,
  telegramConnected,
  channelId,
  coin,
}: {
  messages: ChannelMessage[]
  telegramConnected: boolean
  channelId: string | null
  coin: string
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const fingerprint = messages.map((message) => `${message.id}:${message.editCount}`).join("|")

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !stickToBottom.current) return
    scroller.scrollTop = scroller.scrollHeight
  }, [fingerprint])

  return (
    <section className="flex min-h-[640px] flex-1 flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#17212b] shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
      <header className="flex items-center gap-3 border-b border-white/5 bg-[#17212b] px-4 py-3">
        <div className="flex size-11 items-center justify-center rounded-full bg-gradient-to-br from-amber-300 to-orange-500 text-lg font-semibold text-black">
          S
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold text-white">
              {displayToken(coin)} SNAPSHOTS
            </h2>
            <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] font-medium tracking-wide text-sky-300 uppercase">
              Broadcast
            </span>
          </div>
          <p className="truncate text-xs text-white/50">
            {telegramConnected
              ? `Publishing to ${channelId}`
              : "Preview channel · bot is the only publisher"}
          </p>
        </div>
      </header>

      <div
        ref={scrollerRef}
        onScroll={() => {
          const scroller = scrollerRef.current
          if (!scroller) return
          const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
          stickToBottom.current = remaining < 96
        }}
        className="relative flex-1 overflow-y-auto [overflow-anchor:none] bg-[#0e1621] px-3 py-4"
      >
        <div className="mx-auto mb-4 max-w-sm rounded-2xl bg-[#182533] px-4 py-3 text-center text-[11px] leading-relaxed text-white/45">
          Viewers can only watch automated snapshot results. Commands, replies, and wallet
          requests are disabled on this channel.
        </div>

        {messages.length === 0 ? (
          <div className="mx-auto mt-16 max-w-xs text-center text-sm text-white/40">
            Waiting for the snapshot engine. Nothing in this channel can be triggered by a
            viewer.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <article key={message.id} className="flex justify-start">
                <div
                  className={cn(
                    "max-w-[92%] rounded-2xl rounded-tl-md bg-[#182533] px-3.5 py-2.5 text-[13.5px] leading-[1.45] text-[#e8f1fa] shadow-sm",
                  )}
                >
                  <div className="mb-1 text-[11px] font-medium text-[#6ab3f3]">Snap Broadcast</div>
                  <div className="whitespace-pre-wrap">{renderText(message.text)}</div>
                  <div className="mt-1.5 flex items-center justify-end gap-1 text-[10px] text-white/35">
                    {message.editCount > 0 ? <span>edited</span> : null}
                    <span>
                      {formatClockIso(message.editedAt ?? message.createdAt)}
                    </span>
                    <span className="text-sky-400/80">✓✓</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-white/5 bg-[#17212b] px-4 py-3">
        <div className="flex items-center gap-2 rounded-2xl bg-[#0e1621] px-3 py-2.5 text-sm text-white/30">
          <span className="flex-1">Messaging is disabled in this channel</span>
          <span className="rounded-md border border-white/10 px-2 py-0.5 text-[10px] tracking-wide uppercase">
            No commands
          </span>
        </div>
      </div>
    </section>
  )
}
