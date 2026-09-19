import { requireAdmin } from "@/lib/admin-auth"
import { getRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const denied = requireAdmin(request)
  if (denied) return denied
  try {
    const audit = await getRuntime().engine.runSnapshot("admin")
    return Response.json({ ok: true, audit, state: getRuntime().store.clientState() })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Snapshot failed" },
      { status: 409 },
    )
  }
}
