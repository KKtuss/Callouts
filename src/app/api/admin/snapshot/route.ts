import { requireAdmin } from "@/lib/admin-auth"
import { waitForRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: Request) {
  const denied = requireAdmin(request)
  if (denied) return denied
  try {
    const { engine, store } = await waitForRuntime()
    const audit = await engine.runSnapshot("admin")
    return Response.json({ ok: true, audit, state: store.clientState() })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Snapshot failed" },
      { status: 409 },
    )
  }
}
