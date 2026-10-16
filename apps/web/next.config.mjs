/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@brain/core"],
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  // Permet un build de vérification à côté d'un `next dev` en cours (NEXT_DIST_DIR=.next-build).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
}

export default nextConfig
