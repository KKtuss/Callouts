import { ShillSite } from "@/components/public/shill-site"
import { getRuntime } from "@/engine/runtime"
import { toPublicView } from "@/lib/public-view"

export const dynamic = "force-dynamic"

export default function HomePage() {
  const { store } = getRuntime()
  const initialState = toPublicView(store.clientState())
  return <ShillSite initialState={initialState} />
}
