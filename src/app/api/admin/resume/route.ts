import { requireAdmin } from "@/lib/admin-auth"
import { getRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const denied = requireAdmin(request)
  if (denied) return denied
  getRuntime().engine.resume()
  return Response.json(getRuntime().store.clientState())
}
