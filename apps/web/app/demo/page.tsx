import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { DemoPicker } from "@/components/DemoPicker"
import { isDemoMode, signupOpen } from "@/lib/auth"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Company brain demo" }

/** Demo: you enter Encore's brain by choosing an account. Outside demo mode, the usual sign-in. */
export default function DemoPage() {
  if (!isDemoMode()) redirect("/login")
  return <DemoPicker signup={signupOpen()} />
}
