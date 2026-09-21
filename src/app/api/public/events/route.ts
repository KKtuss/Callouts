import { waitForRuntime } from "@/engine/runtime"
import { toPublicView } from "@/lib/public-view"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

export async function GET(request: Request) {
  const { store, engine } = await waitForRuntime()
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

      const push = () => {
        try {
          send(toPublicView(store.clientState()))
        } catch (error) {
          console.error("[public/events] failed to serialize state", error)
        }
      }

      push()

      // Poller/log chatter can emit many times a second — coalesce for the public board.
      let pending: ReturnType<typeof setTimeout> | null = null
      const unsubscribe = store.subscribe((event) => {
        if (event.type !== "state" || closed) return
        if (pending) return
        pending = setTimeout(() => {
          pending = null
          push()
        }, 250)
      })

      const keepalive = setInterval(() => {
        if (closed) return
        void engine.catchUp().catch(() => undefined)
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`))
        } catch {
          close()
        }
      }, 15_000)

      request.signal.addEventListener("abort", () => {
        if (pending) clearTimeout(pending)
        close()
      })
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
