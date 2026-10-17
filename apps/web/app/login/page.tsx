import { isDemoMode, signupOpen } from "@/lib/auth"
import { getPageViewer, getRememberedAccounts } from "@/lib/session"
import { LoginForm } from "@/components/LoginForm"

export const dynamic = "force-dynamic"

/** Connexion : les entreprises retenues par ce navigateur, et le jeton personnel (`?ajouter=1` l'ouvre d'emblée). */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [viewer, accounts, params] = await Promise.all([getPageViewer(), getRememberedAccounts(), searchParams])
  return <LoginForm demo={isDemoMode()} signup={signupOpen()} accounts={accounts} currentId={viewer?.real.id ?? null} adding={params.ajouter !== undefined} />
}
