import { cookies, headers } from "next/headers"
import { OpsApp } from "@/components/ops-app"
import { getRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"

async function isAuthorized(): Promise<boolean> {
  const expected = process.env.ADMIN_KEY?.trim()
  if (!expected) {
    // Local/dev can stay open; production must set ADMIN_KEY.
    return process.env.NODE_ENV !== "production" && process.env.VERCEL !== "1"
  }

  const headerStore = await headers()
  const header = headerStore.get("x-admin-key")?.trim()
  if (header === expected) return true

  const cookieStore = await cookies()
  const cookie = cookieStore.get("admin_key")?.value?.trim()
  return cookie === expected
}

export default async function OpsPage() {
  const allowed = await isAuthorized()
  if (!allowed) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="max-w-md rounded-2xl border border-white/10 bg-card p-8 text-center shadow-xl">
          <h1 className="text-xl font-semibold tracking-tight">Private ops console</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Set the <code className="text-primary">admin_key</code> cookie or{" "}
            <code className="text-primary">x-admin-key</code> header to match{" "}
            <code className="text-primary">ADMIN_KEY</code>.
          </p>
        </div>
      </main>
    )
  }

  const { store } = getRuntime()
  return <OpsApp initialState={store.clientState()} />
}
