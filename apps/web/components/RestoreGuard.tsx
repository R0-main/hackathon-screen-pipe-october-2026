"use client"

import { useEffect } from "react"

/**
 * Une page restaurée depuis le cache avant/arrière du navigateur (bfcache) n'est pas redemandée au serveur :
 * après une déconnexion, « Précédent » réafficherait le cerveau de la personne précédente. On recharge alors la
 * page, et le serveur renvoie vers /login si la session n'existe plus.
 */
export function RestoreGuard() {
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload()
    }
    window.addEventListener("pageshow", onShow)
    return () => window.removeEventListener("pageshow", onShow)
  }, [])
  return null
}
