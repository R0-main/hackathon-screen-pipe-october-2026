import { Onboarding } from "@/components/Onboarding"
import { ONBOARDING_QUESTIONS } from "@/lib/onboarding"
import { getStore } from "@/lib/store"
import { getClaude } from "@/lib/ai"
import { requirePageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

export default async function OnboardingPage() {
  await requirePageViewer({ admin: true })
  const org = await getStore().getOrg()
  return <Onboarding questions={[...ONBOARDING_QUESTIONS]} orgName={org.name} claude={Boolean(getClaude())} />
}
