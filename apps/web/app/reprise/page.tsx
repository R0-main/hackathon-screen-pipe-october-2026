import { redirect } from "next/navigation"
import { ResumeSession } from "@/components/ResumeSession"
import { canResume, getPageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

/** Session expirée sur une page protégée : on rouvre l'entreprise retenue, puis le dashboard (une seule navigation). */
export default async function ResumePage() {
  if (await getPageViewer()) redirect("/dashboard")
  if (!(await canResume())) redirect("/login")
  return <ResumeSession />
}
