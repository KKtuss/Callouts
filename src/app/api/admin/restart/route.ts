import { requireAdmin } from "@/lib/admin-auth"
import { getRuntime, restartWatchCycle } from "@/engine/runtime"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const denied = requireAdmin(request)
  if (denied) return denied

  try {
    await restartWatchCycle()
    return Response.json(getRuntime().store.clientState())
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Restart failed" },
      { status: 400 },
    )
  }
}
