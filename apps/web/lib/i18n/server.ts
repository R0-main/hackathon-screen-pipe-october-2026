import { cookies, headers } from "next/headers"
import { LANG_COOKIE, getDict, resolveLocale, type Locale } from "./index"

/** Langue de la requête en cours (pages et layouts). */
export async function getLocale(): Promise<Locale> {
  const [jar, h] = await Promise.all([cookies(), headers()])
  return resolveLocale(jar.get(LANG_COOKIE)?.value, h.get("accept-language"))
}

export async function getT() {
  const locale = await getLocale()
  return { locale, t: getDict(locale) }
}
