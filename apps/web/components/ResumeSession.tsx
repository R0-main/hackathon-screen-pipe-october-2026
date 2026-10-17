"use client"

import { useEffect, useRef } from "react"
import { api } from "./format"
import { useT } from "./I18n"
import { BrainIcon } from "./ui"

/**
 * Rouvre l'entreprise retenue la plus récente (POST /api/session/resume), puis charge le dashboard en navigation
 * complète : le routeur client ne suit jamais de redirection vers une route API, et rien de l'ancienne session ne reste
 * en cache. Échec : la page de connexion, qui propose les entreprises retenues.
 */
export function ResumeSession() {
  const { t } = useT()
  // Une seule reprise, même quand React rejoue l'effet (mode strict en développement).
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    api("/api/session/resume", { method: "POST" }).then(
      () => window.location.replace("/dashboard"),
      () => window.location.replace("/login"),
    )
  }, [])
  return (
    <main className="grid min-h-dvh place-items-center px-4" aria-busy>
      <div className="flex flex-col items-center gap-3 text-center">
        <BrainIcon size={40} />
        <p className="text-[13px] text-trace" role="status">
          {t.login.resuming}
        </p>
      </div>
    </main>
  )
}
