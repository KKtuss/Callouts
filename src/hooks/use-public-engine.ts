"use client"

import { useEffect, useRef, useState } from "react"
import type { PublicView } from "@/lib/public-view"

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
    let retryMs = 1000

    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    }

    const connectSse = () => {
      if (cancelled) return
      source?.close()
      source = new EventSource("/api/public/events")
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as PublicView
          hasState = true
          retryMs = 1000
          setState(payload)
          setError(null)
          setConnected(true)
        } catch {
          /* ignore keepalive or malformed */
        }
      }
      source.onerror = () => {
        if (cancelled) return
        setConnected(false)
        source?.close()
        source = null
        if (!hasState) {
          setError("Live updates interrupted. Reconnecting…")
        }
        clearRetry()
        retryTimer = setTimeout(() => {
          retryMs = Math.min(retryMs * 2, 15_000)
          void bootstrap()
        }, retryMs)
      }
    }

    const bootstrap = async () => {
      try {
        const response = await fetch("/api/public/state", { cache: "no-store" })
        if (!response.ok) throw new Error("Failed to load live status")
        const next = (await response.json()) as PublicView
        if (!cancelled) {
          hasState = true
          setState(next)
          setError(null)
          setConnected(true)
        }
      } catch (err) {
        if (!cancelled && !hasState) {
          setError(err instanceof Error ? err.message : "Engine unreachable")
          setConnected(false)
        }
      }
      connectSse()
    }

    void bootstrap()
    return () => {
      cancelled = true
      clearRetry()
      source?.close()
    }
  }, [])

  return { state, error, connected }
}
