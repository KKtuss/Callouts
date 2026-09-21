"use client"

import { useEffect, useRef, useState } from "react"
import { mergeClientState } from "@/lib/merge-live-state"
import type { ClientState } from "@/engine/types"

const POLL_MS = 1_000

export function useEngineState(initialState: ClientState | null = null) {
  const [state, setState] = useState<ClientState | null>(initialState)
  const [error, setError] = useState<string | null>(null)
  const firstPaint = useRef(initialState)

  useEffect(() => {
    let source: EventSource | null = null
    let cancelled = false
    let hasState = Boolean(firstPaint.current)
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let retryMs = 1000

    const apply = (next: ClientState) => {
      hasState = true
      setState((prev) => mergeClientState(prev, next))
      setError(null)
    }

    const pull = async () => {
      try {
        const response = await fetch("/api/state", { cache: "no-store" })
        if (!response.ok) throw new Error("Failed to load engine state")
        const next = (await response.json()) as ClientState
        if (!cancelled) apply(next)
      } catch (err) {
        if (!cancelled && !hasState) {
          setError(err instanceof Error ? err.message : "Engine unreachable")
        }
      }
    }

    const connectSse = () => {
      if (cancelled) return
      source?.close()
      source = new EventSource("/api/events")
      source.onmessage = (event) => {
        try {
          apply(JSON.parse(event.data) as ClientState)
          retryMs = 1000
        } catch {
          /* ignore keepalive or malformed */
        }
      }
      source.onerror = () => {
        if (cancelled) return
        source?.close()
        source = null
        if (retryTimer) return
        retryTimer = setTimeout(() => {
          retryTimer = null
          retryMs = Math.min(retryMs * 2, 15_000)
          void pull().then(connectSse)
        }, retryMs)
      }
    }

    void pull().then(connectSse)
    pollTimer = setInterval(() => {
      void pull()
    }, POLL_MS)

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      if (pollTimer) clearInterval(pollTimer)
      source?.close()
    }
  }, [])

  return { state, error }
}
