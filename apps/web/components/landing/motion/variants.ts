/**
 * Versions du motion design de la page d'accueil, à comparer avec `/?v=<id>`. « Actuelle » garde la page telle
 * qu'elle était (seule la scène du cerveau bouge) ; les trois autres animent aussi l'accueil et les sections.
 */
export const MOTION_VARIANTS = [
  { id: "actuelle", label: "Actuelle", hint: "La page sans ajout : seule la scène du cerveau bouge." },
  { id: "epure", label: "1. Épure", hint: "Révélations sobres au rythme du scroll : les titres montent ligne par ligne." },
  { id: "recit", label: "2. Récit", hint: "Un fil de billes relie les sections ; le panneau et le schéma se jouent pendant l'arrêt." },
  { id: "cinetique", label: "3. Cinétique", hint: "Plus expressif : titres croisés, prompt décodé, boutons magnétiques." },
] as const

export type MotionVariant = (typeof MOTION_VARIANTS)[number]["id"]

export const DEFAULT_VARIANT: MotionVariant = "actuelle"

export function parseVariant(v: string | string[] | undefined): MotionVariant {
  const id = Array.isArray(v) ? v[0] : v
  return MOTION_VARIANTS.find((m) => m.id === id)?.id ?? DEFAULT_VARIANT
}
