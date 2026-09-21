"use client"

import { useEffect } from "react"

/**
 * Hidden iframe bridge so the FOMO web tab can ingest without CORS/CSP fetch blocks.
 * Parent (fomo.family) postMessages { type, adminKey, body } here.
 */
export default function IngestBridgePage() {
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== "https://fomo.family" && event.origin !== "https://www.fomo.family") {
        return
      }
      const data = event.data
      if (!data || data.type !== "shill-ingest") return
      const adminKey = typeof data.adminKey === "string" ? data.adminKey : ""
      const body = data.body
      if (!adminKey || !body || typeof body !== "object") {
        event.source?.postMessage?.(
          { type: "shill-ingest-result", ok: false, error: "bad_payload" },
          { targetOrigin: event.origin },
        )
        return
      }
      try {
        const res = await fetch("/api/ingest/callout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-key": adminKey,
          },
          body: JSON.stringify(body),
        })
        const text = await res.text()
        event.source?.postMessage?.(
          {
            type: "shill-ingest-result",
            ok: res.ok || res.status === 409,
            status: res.status,
            text: text.slice(0, 300),
            id: body.id,
          },
          { targetOrigin: event.origin },
        )
      } catch (error) {
        event.source?.postMessage?.(
          {
            type: "shill-ingest-result",
            ok: false,
            error: error instanceof Error ? error.message : "fetch_failed",
          },
          { targetOrigin: event.origin },
        )
      }
    }
    window.addEventListener("message", onMessage)
    window.parent?.postMessage?.({ type: "shill-bridge-ready" }, "*")
    return () => window.removeEventListener("message", onMessage)
  }, [])

  return (
    <main style={{ fontFamily: "monospace", padding: 12, fontSize: 12 }}>
      SHILL ingest bridge — keep this iframe loaded from the FOMO watcher.
    </main>
  )
}
