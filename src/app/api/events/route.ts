import { getRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  const { store } = getRuntime()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      send(store.clientState())
      const unsubscribe = store.subscribe((event) => {
        if (event.type === "state") send(event.state)
      })

      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(`: keepalive\n\n`))
      }, 15_000)

      const abort = () => {
        clearInterval(keepalive)
        unsubscribe()
        controller.close()
      }

      request.signal.addEventListener("abort", abort)
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
