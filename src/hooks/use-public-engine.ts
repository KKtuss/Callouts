"use client"

import { useEffect, useRef, useState } from "react"
import { mergePublicView } from "@/lib/merge-live-state"
import type { PublicView } from "@/lib/public-view"

const POLL_MS = 1_000

export function usePublicEngine(initialState: PublicView | null = null) {
  const [state, setState] = useState<PublicView | null>(initialState)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(Boolean(initialState))
  const firstPaint = useRef(initialState)

  useEffect(() => {
    let source: EventSource | null = null
    let cancelled = false
    let hasState = Boolean(firstPaint.current)
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let retryMs = 1000

    const apply = (next: PublicView) => {
      hasState = true
      setState((prev) => mergePublicView(prev, next))
      setError(null)
      setConnected(true)
    }

    const pull = async () => {
      try {
        const response = await fetch("/api/public/state", { cache: "no-store" })
        if (!response.ok) throw new Error("Failed to load live status")
        const next = (await response.json()) as PublicView
        if (!cancelled) apply(next)
      } catch (err) {
        if (!cancelled && !hasState) {
          setError(err instanceof Error ? err.message : "Engine unreachable")
          setConnected(false)
        }
      }
    }

    const connectSse = () => {
      if (cancelled) return
      source?.close()
      source = new EventSource("/api/public/events")
      source.onmessage = (event) => {
        try {
          apply(JSON.parse(event.data) as PublicView)
          retryMs = 1000
        } catch {
          /* ignore keepalive or malformed */
        }
      }
      source.onerror = () => {
        if (cancelled) return
        setConnected(false)
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

  return { state, error, connected }
}
