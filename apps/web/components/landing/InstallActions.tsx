"use client"

import Link from "next/link"
import { useRef } from "react"
import { PromptActions } from "../PromptActions"

/**
 * Le prompt d'installation depuis la page d'accueil. En mode démo, il est demandé au premier clic
 * (`POST /api/demo/install` crée un compte visiteur et son jeton), puis gardé pour les clics suivants.
 * Hors démo, on crée son entreprise (/creer) ou on se connecte avec le jeton remis par son admin.
 */
export function InstallActions({ demo, signup }: { demo: boolean; signup: boolean }) {
  const prompt = useRef<Promise<string> | null>(null)

  if (!demo) {
    return (
      <div className="panel px-5 py-5">
        <p className="text-[15px]">
          {signup
            ? "Créez le cerveau de votre entreprise : quatre questions, puis votre prompt. Vos collègues reçoivent le leur, avec leur jeton personnel, quand vous les invitez."
            : "Votre prompt, avec votre jeton personnel, vous est remis par l'admin de votre cerveau."}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {signup && (
            <Link href="/creer" className="btn btn-primary btn-lg">
              Créer mon entreprise
            </Link>
          )}
          <Link href="/login" className={`btn btn-lg ${signup ? "" : "btn-primary"}`}>
            Se connecter
          </Link>
        </div>
      </div>
    )
  }

  // Une seule requête par visite : un clic sur « Copier » puis sur « Ouvrir » utilisent le même compte visiteur.
  const getPrompt = () => {
    prompt.current ??= fetch("/api/demo/install", { method: "POST" }).then(async (res) => {
      const body = (await res.json().catch(() => ({}))) as { prompt?: string; error?: string }
      if (!res.ok || !body.prompt) throw new Error(body.error ?? "Le prompt n'a pas pu être préparé.")
      return body.prompt
    })
    prompt.current.catch(() => (prompt.current = null))
    return prompt.current
  }

  return (
    <div className="panel px-5 py-5">
      <PromptActions getPrompt={getPrompt} />
      <p className="mt-4 border-t border-line pt-4 text-[13px] leading-relaxed text-trace">
        Démo publique : le prompt vous crée un compte visiteur sur le cerveau de Butine, avec votre propre jeton. Ce que votre poste y envoie ensuite est visible
        des autres visiteurs de la démo. Tout se retire avec <span className="mono text-ink">~/.company-brain/brain uninstall</span>.
        {signup && (
          <>
            {" "}
            Pour votre équipe, <Link href="/creer" className="landing-link text-ink">créez plutôt le cerveau de votre entreprise</Link>.
          </>
        )}
      </p>
    </div>
  )
}
