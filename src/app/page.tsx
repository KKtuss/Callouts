import { OpsApp } from "@/components/ops-app"
import { getRuntime } from "@/engine/runtime"

export const dynamic = "force-dynamic"

export default function Home() {
  const { store } = getRuntime()
  return <OpsApp initialState={store.clientState()} />
}
