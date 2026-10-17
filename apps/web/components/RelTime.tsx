"use client"

import { absoluteTime, relativeTime } from "./format"
import { useT } from "./I18n"

/**
 * Date relative (« il y a 3 minutes »). `now` doit venir du serveur au premier rendu pour que le HTML et
 * l'hydratation affichent le même texte ; suppressHydrationWarning couvre les écarts résiduels (ICU du navigateur).
 */
export function RelTime({ iso, now, className }: { iso: string | null | undefined; now?: number; className?: string }) {
  const { locale } = useT()
  return (
    <time dateTime={iso ?? undefined} title={absoluteTime(iso, locale) || undefined} className={className} suppressHydrationWarning>
      {relativeTime(iso, now, locale)}
    </time>
  )
}
