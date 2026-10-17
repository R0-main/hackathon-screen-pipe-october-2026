// Langue de l'interface : cookie `brain_lang` (posé par le sélecteur), sinon Accept-Language, sinon français.
// Ce module n'importe rien de React ni de Next : utilisable côté serveur, côté client et dans les scripts.

import { en, fr, type Dict } from "./dict"

export type { Dict } from "./dict"

export const LOCALES = ["fr", "en"] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = "fr"
export const LANG_COOKIE = "brain_lang"

const DICTS: Record<Locale, Dict> = { fr, en }

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v)
}

export function getDict(locale: Locale): Dict {
  return DICTS[locale] ?? fr
}

/** Langue à partir du cookie, puis de l'en-tête Accept-Language (« en-US,en;q=0.9,fr;q=0.8 »). */
export function resolveLocale(cookie: string | null | undefined, acceptLanguage?: string | null): Locale {
  if (isLocale(cookie)) return cookie
  for (const part of (acceptLanguage ?? "").split(",")) {
    const code = part.trim().split(";")[0].slice(0, 2).toLowerCase()
    if (isLocale(code)) return code
  }
  return DEFAULT_LOCALE
}

/** Remplace `{n}`, `{name}`… par leurs valeurs. */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/** Pluriel simple : `{n} agent actif` / `{n} agents actifs`. */
export function plural(n: number, one: string, many: string, vars: Record<string, string | number> = {}): string {
  return fmt(n > 1 ? many : one, { n, ...vars })
}

/** Locale BCP 47 pour Intl (dates relatives, formats). */
export function intlLocale(locale: Locale): string {
  return locale === "en" ? "en-GB" : "fr-FR"
}
