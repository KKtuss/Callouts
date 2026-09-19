import { getRuntime } from "@/engine/runtime"
import { toPublicView } from "@/lib/public-view"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  const { store } = getRuntime()
  return Response.json(toPublicView(store.clientState()))
}
