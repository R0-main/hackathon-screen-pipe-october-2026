import { permanentRedirect } from "next/navigation"

/** Ancienne adresse de la page d'accueil, qui vit maintenant sur `/`. */
export default function AccueilPage() {
  permanentRedirect("/")
}
