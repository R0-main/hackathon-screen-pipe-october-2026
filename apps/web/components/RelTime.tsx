"use client"

import { absoluteTime, relativeTime } from "./format"
import { useT } from "./I18n"

/**
 * Relative date ("3 minutes ago"). `now` must come from the server on the first render so that the HTML and
 * hydration show the same text; suppressHydrationWarning covers the remaining differences (the browser's ICU).
 */
export function RelTime({ iso, now, className }: { iso: string | null | undefined; now?: number; className?: string }) {
  const { locale } = useT()
  return (
    <time dateTime={iso ?? undefined} title={absoluteTime(iso, locale) || undefined} className={className} suppressHydrationWarning>
      {relativeTime(iso, now, locale)}
    </time>
  )
}
