import { getRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  const { store } = getRuntime()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      let closed = false

      const close = () => {
        if (closed) return
        closed = true
        clearInterval(keepalive)
        unsubscribe()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }

      const send = (data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          close()
        }
      }

      send(store.clientState())
      const unsubscribe = store.subscribe((event) => {
        if (event.type === "state") send(event.state)
      })

      const keepalive = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`))
        } catch {
          close()
        }
      }, 15_000)

      request.signal.addEventListener("abort", close)
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
