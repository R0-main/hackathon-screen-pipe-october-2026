"use client"

import { useEffect, useRef } from "react"
import { api } from "./format"
import { useT } from "./I18n"
import { LogoMark } from "./ui"

/**
 * Reopens the most recent remembered company (POST /api/session/resume), then loads the dashboard with a full
 * navigation: the client router never follows a redirect to an API route, and nothing from the old session stays
 * cached. On failure: the sign-in page, which offers the remembered companies.
 */
export function ResumeSession() {
  const { t } = useT()
  // A single resume, even when React replays the effect (strict mode in development).
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
        <LogoMark size={40} />
        <p className="text-[13px] text-trace" role="status">
          {t.login.resuming}
        </p>
      </div>
    </main>
  )
}
