import { absoluteTime, relativeTime } from "./format"

/**
 * Date relative (« il y a 3 minutes »). `now` doit venir du serveur au premier rendu pour que le HTML et
 * l'hydratation affichent le même texte ; suppressHydrationWarning couvre les écarts résiduels (ICU du navigateur).
 */
export function RelTime({ iso, now, className }: { iso: string | null | undefined; now?: number; className?: string }) {
  return (
    <time dateTime={iso ?? undefined} title={absoluteTime(iso) || undefined} className={className} suppressHydrationWarning>
      {relativeTime(iso, now)}
    </time>
  )
}
