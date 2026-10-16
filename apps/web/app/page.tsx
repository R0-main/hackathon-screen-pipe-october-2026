import { Dashboard } from "@/components/Dashboard"
import { getState } from "@/lib/brain"
import { requirePageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

export default async function Home() {
  const viewer = await requirePageViewer()
  const state = await getState(viewer)
  return <Dashboard initial={state} />
}
