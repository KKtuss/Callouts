import { ShillSite } from "@/components/public/shill-site"
import { waitForPublicRuntime } from "@/engine/runtime"
import { toPublicView } from "@/lib/public-view"

export const dynamic = "force-dynamic"

export default async function HomePage() {
  const { store } = await waitForPublicRuntime()
  const initialState = toPublicView(store.clientState())
  return <ShillSite initialState={initialState} />
}
