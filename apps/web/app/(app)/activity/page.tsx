import { redirect } from "next/navigation"

// The agents feed now lives on the brain: old links to /activity lead there.
export default function Page() {
  redirect("/dashboard")
}
