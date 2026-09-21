import { requireAdmin } from "@/lib/admin-auth"
import { waitForRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const denied = requireAdmin(request)
  if (denied) return denied

  try {
    const { migrationMonitor, store } = await waitForRuntime()
    const audit = await migrationMonitor.pollOnce()
    return Response.json({
      audit,
      state: store.clientState(),
    })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Migration check failed" },
      { status: 400 },
    )
  }
}
