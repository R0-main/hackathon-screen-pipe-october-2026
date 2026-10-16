/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@brain/core"],
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
}

export default nextConfig
