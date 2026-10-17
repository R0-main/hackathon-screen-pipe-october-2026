"use client"

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react"
import { LANG_COOKIE, LOCALES, getDict, type Dict, type Locale } from "@/lib/i18n"

type I18n = { locale: Locale; t: Dict; setLocale: (l: Locale) => void }

const Ctx = createContext<I18n | null>(null)

/** Langue de l'interface, posée par le layout racine ; `setLocale` écrit le cookie et recharge (le serveur re-rend dans la langue). */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const setLocale = useCallback((l: Locale) => {
    document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`
    window.location.reload()
  }, [])
  const value = useMemo(() => ({ locale, t: getDict(locale), setLocale }), [locale, setLocale])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useT(): I18n {
  const v = useContext(Ctx)
  // Hors provider (test, composant isolé) : français.
  return v ?? { locale: "fr", t: getDict("fr"), setLocale: () => {} }
}

/** Sélecteur de langue : une rangée de puces, la langue courante enfoncée. */
export function LanguageSwitch({ className = "" }: { className?: string }) {
  const { locale, t, setLocale } = useT()
  return (
    <div className={`flex items-center gap-1 ${className}`} role="group" aria-label={t.lang.label}>
      {LOCALES.map((l) => (
        <button key={l} type="button" className={`chip ${l === locale ? "chip-on" : ""}`} aria-pressed={l === locale} onClick={() => l !== locale && setLocale(l)} lang={l}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
