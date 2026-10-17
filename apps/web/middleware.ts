import { NextResponse, type NextRequest } from "next/server"

// Même nom que SESSION_COOKIE (lib/auth.ts), recopié ici : le middleware tourne hors de Node et ne peut pas importer lib/auth.
const SESSION_COOKIE = "brain_session"

/**
 * `/` sans session : la page d'accueil publique (l'URL reste `/`). Avec un cookie, le dashboard ; un cookie
 * expiré ou invalide est renvoyé vers /login par le layout des pages connectées.
 */
export function middleware(req: NextRequest) {
  if (req.cookies.has(SESSION_COOKIE)) return NextResponse.next()
  return NextResponse.rewrite(new URL("/accueil", req.url))
}

export const config = { matcher: "/" }
