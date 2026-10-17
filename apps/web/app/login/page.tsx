import { isDemoMode, signupOpen } from "@/lib/auth"
import { getPageViewer, getRememberedAccounts } from "@/lib/session"
import { LoginForm } from "@/components/LoginForm"

export const dynamic = "force-dynamic"

/** Sign-in: the companies remembered by this browser, and the personal token (`?add=1` opens it right away). */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [viewer, accounts, params] = await Promise.all([getPageViewer(), getRememberedAccounts(), searchParams])
  return <LoginForm demo={isDemoMode()} signup={signupOpen()} accounts={accounts} currentId={viewer?.real.id ?? null} adding={params.add !== undefined} />
}
