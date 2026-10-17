import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { DEFAULT_ZONES } from "@brain/core"
import { CreateCompany } from "@/components/CreateCompany"
import { isDemoMode, signupOpen } from "@/lib/auth"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Create my company" }

/** Create one's company brain from scratch: a few questions, one's prompt, then the team's. */
export default function CreatePage() {
  if (!signupOpen()) redirect("/login")
  const zones = DEFAULT_ZONES.map(({ id, name, description, color, position }) => ({ id, name, description, color, position }))
  return <CreateCompany zones={zones} demo={isDemoMode()} />
}
