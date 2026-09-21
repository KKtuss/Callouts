import { waitForRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET() {
  const { store } = await waitForRuntime()
  return Response.json(store.clientState(), {
    headers: { "Cache-Control": "no-store" },
  })
}
