"use client"

import { AdminPanel } from "@/components/admin-panel"
import { ChannelPreview } from "@/components/channel-preview"
import { useEngineState } from "@/hooks/use-engine-state"

export function OpsApp() {
  const { state, error } = useEngineState()

  if (!state) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {error ?? "Starting snapshot engine…"}
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6 px-4 py-6 lg:px-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <p className="text-xs font-medium tracking-[0.2em] text-amber-300/80 uppercase">
            Broadcast-only public surface
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-white">Callout Snap</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/60">
            The Telegram channel is an output layer. Snapshots, CSPRNG selection, and treasury
            sends run in the private engine. Viewers cannot configure, trigger, or influence a
            round.
          </p>
        </div>
        {error ? (
          <p className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs text-amber-200">
            {error}
          </p>
        ) : null}
      </header>

      <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-[11px] tracking-wide text-white/50 uppercase sm:grid-cols-[1fr_auto_1fr] sm:items-center">
        <div>
          <div className="text-amber-200/80">Public</div>
          <div className="mt-1 normal-case tracking-normal text-white/80">
            Telegram channel → broadcast messages only
          </div>
        </div>
        <div className="hidden text-center text-white/25 sm:block">does not control</div>
        <div>
          <div className="text-sky-200/80">Private</div>
          <div className="mt-1 normal-case tracking-normal text-white/80">
            Collector → snapshot engine → CSPRNG selection → treasury → chain → Telegram
          </div>
        </div>
      </div>

      <div className="grid flex-1 items-stretch gap-6 xl:grid-cols-[minmax(320px,440px)_1fr]">
        <ChannelPreview
          messages={state.messages}
          telegramConnected={state.status.telegramConnected}
          channelId={state.status.telegramChannelId}
        />
        <AdminPanel state={state} />
      </div>
    </div>
  )
}
