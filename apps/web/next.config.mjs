import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Dernière migration livrée avec ce code (supabase/migrations), figée au build : /api/health la compare à la dernière
// migration appliquée en base, pour voir de l'extérieur si la base est à jour (les fichiers .sql ne sont pas embarqués
// dans les fonctions Vercel, d'où la valeur figée ici).
function latestMigration() {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations")
    return fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().at(-1) ?? ""
  } catch {
    return ""
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@brain/core"],
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  // Permet un build de vérification à côté d'un `next dev` en cours (NEXT_DIST_DIR=.next-build).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  env: { BRAIN_EXPECTED_MIGRATION: latestMigration() },
}

export default nextConfig
