import { requireAdmin } from "@/lib/admin-auth"
import { getRuntime } from "@/engine/runtime"
import type { EngineConfig } from "@/engine/types"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const denied = requireAdmin(request)
  if (denied) return denied

  const body = (await request.json()) as Partial<EngineConfig>
  try {
    getRuntime().engine.updateConfig(body)
    return Response.json(getRuntime().store.clientState())
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid config" },
      { status: 400 },
    )
  }
}
