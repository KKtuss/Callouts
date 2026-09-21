import { waitForRuntime } from "@/engine/runtime"
import { toPublicView } from "@/lib/public-view"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  const { store } = await waitForRuntime()
  return Response.json(toPublicView(store.clientState()), {
    headers: { "Cache-Control": "no-store" },
  })
}
