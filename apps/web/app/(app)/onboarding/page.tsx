import { Onboarding } from "@/components/Onboarding"
import { ONBOARDING_QUESTIONS } from "@/lib/onboarding"
import { storeForOrg } from "@/lib/store"
import { getClaude } from "@/lib/ai"
import { requirePageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

export default async function OnboardingPage() {
  const viewer = await requirePageViewer({ admin: true })
  const store = storeForOrg(viewer.real.org_id)
  const [org, claude] = await Promise.all([store.getOrg(), getClaude(store)])
  return <Onboarding questions={[...ONBOARDING_QUESTIONS]} orgName={org.name} claude={Boolean(claude)} />
}
