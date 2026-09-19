import { getRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"

export async function GET() {
  const { store } = getRuntime()
  return Response.json(store.clientState())
}
