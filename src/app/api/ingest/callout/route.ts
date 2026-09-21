import { DuplicateCalloutError, isDuplicateCalloutError } from "@/engine/collector"
import { requireAdmin } from "@/lib/admin-auth"
import { getRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"

const ALLOW_ORIGINS = new Set([
  "https://fomo.family",
  "https://www.fomo.family",
  "https://callout-beta.vercel.app",
  "http://localhost:43147",
])

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin") || ""
  const allow = ALLOW_ORIGINS.has(origin) ? origin : "https://fomo.family"
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-key, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  }
}

function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, v)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request: Request) {
  const denied = requireAdmin(request)
  if (denied) return withCors(request, denied)

  const body = (await request.json()) as {
    token?: string
    callerUsername?: string
    wallet?: string
    source?: string
    capturedAt?: string
    id?: string
    thesis?: string
    silent?: boolean
  }

  try {
    const callout = getRuntime().engine.ingestCallout({
      token: body.token,
      callerUsername: body.callerUsername ?? "",
      wallet: body.wallet ?? "",
      source: body.source,
      capturedAt: body.capturedAt,
      id: body.id,
      thesis: body.thesis,
      silent: body.silent,
    })
    return withCors(request, Response.json({ callout, state: getRuntime().store.clientState() }))
  } catch (error) {
    if (isDuplicateCalloutError(error)) {
      return withCors(
        request,
        Response.json({ error: error.message, callout: error.existing }, { status: 409 }),
      )
    }
    return withCors(
      request,
      Response.json(
        { error: error instanceof Error ? error.message : "Invalid callout" },
        { status: 400 },
      ),
    )
  }
}
