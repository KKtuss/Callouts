import { requireAdmin } from "@/lib/admin-auth"
import { getRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const denied = requireAdmin(request)
  if (denied) return denied

  try {
    const audit = await getRuntime().migrationMonitor.pollOnce()
    return Response.json({
      audit,
      state: getRuntime().store.clientState(),
    })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Migration check failed" },
      { status: 400 },
    )
  }
}
