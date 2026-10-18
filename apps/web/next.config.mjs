import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Last migration shipped with this code (supabase/migrations), frozen at build time: /api/health compares it with the
// last migration applied in the database, to see from outside whether the database is up to date (the .sql files are
// not bundled into the Vercel functions, hence the value frozen here).
function latestMigration() {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations")
    return fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().at(-1) ?? ""
  } catch {
    return ""
  }
}

/** Former French addresses, kept as permanent redirects so links and install prompts already shared keep working. */
const LEGACY_PATHS = [
  ["/accueil", "/"],
  ["/creer", "/create"],
  ["/activite", "/activity"],
  ["/etat", "/status"],
  ["/connaissances", "/knowledge"],
  ["/entites", "/entities"],
  ["/entites/:path*", "/entities/:path*"],
  ["/taches", "/tasks"],
  ["/automatisations", "/automations"],
  ["/connecteurs", "/connectors"],
  ["/supervision", "/monitoring"],
  ["/admin/acces", "/admin/access"],
  ["/admin/demandes", "/admin/requests"],
  ["/reprise", "/resume"],
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@brain/core"],
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  // Allows a verification build next to a running `next dev` (NEXT_DIST_DIR=.next-build).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  env: { BRAIN_EXPECTED_MIGRATION: latestMigration() },
  // The MCP App (scripts/build-mcp-apps.ts), read from disk by the MCP endpoint: shipped with its functions.
  outputFileTracingIncludes: { "/api/mcp/**": ["./.mcp-apps/**"] },
  async redirects() {
    return LEGACY_PATHS.map(([source, destination]) => ({ source, destination, permanent: true }))
  },
}

export default nextConfig
