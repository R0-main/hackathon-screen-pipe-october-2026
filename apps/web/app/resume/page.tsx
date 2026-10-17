import { redirect } from "next/navigation"
import { ResumeSession } from "@/components/ResumeSession"
import { canResume, getPageViewer } from "@/lib/session"

export const dynamic = "force-dynamic"

/** Session expired on a protected page: reopen the remembered company, then the dashboard (a single navigation). */
export default async function ResumePage() {
  if (await getPageViewer()) redirect("/dashboard")
  if (!(await canResume())) redirect("/login")
  return <ResumeSession />
}
