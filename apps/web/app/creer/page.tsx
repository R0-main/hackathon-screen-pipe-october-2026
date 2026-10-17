import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { DEFAULT_ZONES } from "@brain/core"
import { CreateCompany } from "@/components/CreateCompany"
import { isDemoMode, signupOpen } from "@/lib/auth"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Créer mon entreprise" }

/** Créer le cerveau de son entreprise à partir de zéro : quelques questions, son prompt, puis ceux de l'équipe. */
export default function CreatePage() {
  if (!signupOpen()) redirect("/login")
  const zones = DEFAULT_ZONES.map(({ id, name, description, color, position }) => ({ id, name, description, color, position }))
  return <CreateCompany zones={zones} demo={isDemoMode()} />
}
