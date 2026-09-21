import { waitForRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function authorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim()
  const adminKey = process.env.ADMIN_KEY?.trim()
  const auth = request.headers.get("authorization")?.trim() ?? ""
  const headerKey = request.headers.get("x-admin-key")?.trim() ?? ""
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true
  if (adminKey && (headerKey === adminKey || auth === `Bearer ${adminKey}`)) return true
  return false
}

/**
 * Vercel Cron + manual wake. Fires a scheduler snapshot when the OPS
 * countdown is due, instead of relying on setTimeout surviving isolate sleep.
 */
export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { engine, store } = await waitForRuntime()
  const audit = await engine.catchUp()
  return Response.json({
    ok: true,
    fired: Boolean(audit),
    confirmationStatus: audit?.confirmationStatus ?? null,
    nextSnapshotAt: store.nextSnapshotAt,
    lastSnapshotAt: store.lastSnapshotAt,
  })
}
