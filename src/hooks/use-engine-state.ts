"use client"

import { useEffect, useState } from "react"
import type { ClientState } from "@/engine/types"

export function useEngineState() {
  const [state, setState] = useState<ClientState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let source: EventSource | null = null
    let cancelled = false

    const connect = async () => {
      try {
        const response = await fetch("/api/state")
        if (!response.ok) throw new Error("Failed to load engine state")
        const initial = (await response.json()) as ClientState
        if (!cancelled) {
          setState(initial)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Engine unreachable")
      }

      source = new EventSource("/api/events")
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as ClientState
          setState(payload)
          setError(null)
        } catch {
          /* ignore keepalive or malformed */
        }
      }
      source.onerror = () => {
        setError("Live updates interrupted. Reconnecting…")
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
