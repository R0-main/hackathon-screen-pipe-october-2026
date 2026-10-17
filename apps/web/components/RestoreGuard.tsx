"use client"

import { useEffect } from "react"

/**
 * A page restored from the browser's back/forward cache (bfcache) is not requested from the server again:
 * after signing out, "Back" would show the previous person's brain again. The page is then reloaded,
 * and the server redirects to /login if the session no longer exists.
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
