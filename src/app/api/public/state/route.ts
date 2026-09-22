import { waitForPublicRuntime } from "@/engine/runtime"
import { toPublicView } from "@/lib/public-view"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

export async function GET() {
  const { store } = await waitForPublicRuntime()
  return Response.json(toPublicView(store.clientState()), {
    headers: { "Cache-Control": "no-store" },
  })
}
