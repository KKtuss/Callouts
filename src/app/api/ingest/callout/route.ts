import { requireAdmin } from "@/lib/admin-auth"
import { getRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const denied = requireAdmin(request)
  if (denied) return denied

  const body = (await request.json()) as {
    token?: string
    callerUsername?: string
    wallet?: string
    source?: string
  }

  try {
    const callout = getRuntime().engine.ingestCallout({
      token: body.token ?? "",
      callerUsername: body.callerUsername ?? "",
      wallet: body.wallet ?? "",
      source: body.source,
    })
    return Response.json({ callout, state: getRuntime().store.clientState() })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid callout" },
      { status: 400 },
    )
  }
}
