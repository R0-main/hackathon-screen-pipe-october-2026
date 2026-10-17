import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { DemoPicker } from "@/components/DemoPicker"
import { isDemoMode, signupOpen } from "@/lib/auth"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Démo du cerveau d'entreprise" }

/** Démo : on entre dans le cerveau de Butine en choisissant un compte. Hors mode démo, la connexion classique. */
export default function DemoPage() {
  if (!isDemoMode()) redirect("/login")
  return <DemoPicker signup={signupOpen()} />
}
