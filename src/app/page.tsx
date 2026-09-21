import { ShillSite } from "@/components/public/shill-site"
import { waitForRuntime } from "@/engine/runtime"
import { toPublicView } from "@/lib/public-view"

export const dynamic = "force-dynamic"

export default async function HomePage() {
  const { store } = await waitForRuntime()
  const initialState = toPublicView(store.clientState())
  return <ShillSite initialState={initialState} />
}
