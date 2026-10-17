"use client"

import { LOCALE, getDict, type Dict, type Locale } from "@/lib/i18n"

type I18n = { locale: Locale; t: Dict }

const VALUE: I18n = { locale: LOCALE, t: getDict() }

/** Interface strings (English only). */
export function useT(): I18n {
  return VALUE
}
