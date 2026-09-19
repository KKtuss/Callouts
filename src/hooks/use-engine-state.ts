"use client"

import { useEffect, useRef, useState } from "react"
import type { ClientState } from "@/engine/types"

export function useEngineState(initialState: ClientState | null = null) {
  const [state, setState] = useState<ClientState | null>(initialState)
  const [error, setError] = useState<string | null>(null)
  const firstPaint = useRef(initialState)

  useEffect(() => {
    let source: EventSource | null = null
    let cancelled = false
    let hasState = Boolean(firstPaint.current)

    const connect = async () => {
      try {
        const response = await fetch("/api/state", { cache: "no-store" })
        if (!response.ok) throw new Error("Failed to load engine state")
        const next = (await response.json()) as ClientState
        if (!cancelled) {
          hasState = true
          setState(next)
          setError(null)
        }
      } catch (err) {
        if (!cancelled && !hasState) {
          setError(err instanceof Error ? err.message : "Engine unreachable")
        }
      }

      source = new EventSource("/api/events")
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as ClientState
          hasState = true
          setState(payload)
          setError(null)
        } catch {
          /* ignore keepalive or malformed */
        }
      }
      source.onerror = () => {
        if (!cancelled && !hasState) {
          setError("Live updates interrupted. Reconnecting…")
        }
      }
    }

    void connect()
    return () => {
      cancelled = true
      source?.close()
    }
  }, [])

  return { state, error }
}
