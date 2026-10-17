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
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@brain/core"],
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  // Allows a verification build next to a running `next dev` (NEXT_DIST_DIR=.next-build).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  async redirects() {
    return LEGACY_PATHS.map(([source, destination]) => ({ source, destination, permanent: true }))
  },
}

export default nextConfig
