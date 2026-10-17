import { LOCALE, getDict, type Locale } from "./index"

/** Language of the current request (pages and layouts): always English. */
export async function getLocale(): Promise<Locale> {
  return LOCALE
}

export async function getT() {
  return { locale: LOCALE, t: getDict() }
}
