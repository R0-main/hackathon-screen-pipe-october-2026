// Interface strings, in English. This module imports nothing from React or Next: usable on the server, on the client
// and in scripts.

import { en, type Dict } from "./dict"

export type { Dict } from "./dict"

export type Locale = "en"
export const LOCALE: Locale = "en"

/** `_locale` is accepted for callers that still pass one: there is only English. */
export function getDict(_locale?: Locale): Dict {
  return en
}

/** Replaces `{n}`, `{name}`… with their values. */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/** Simple plural: `{n} active agent` / `{n} active agents`. */
export function plural(n: number, one: string, many: string, vars: Record<string, string | number> = {}): string {
  return fmt(n === 1 ? one : many, { n, ...vars })
}

/** BCP 47 locale for Intl (relative dates, formats). */
export const INTL_LOCALE = "en-GB"

export function intlLocale(_locale?: Locale): string {
  return INTL_LOCALE
}
