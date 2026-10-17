import { brainCa } from "@/lib/ca"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Certificate of a self-hosted brain's private authority (to check by its fingerprint, given in the prompt). */
export async function GET() {
  const ca = brainCa()
  if (!ca) return new Response("This brain has no private certificate.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
  return new Response(ca.pem, { headers: { "content-type": "application/x-pem-file", "cache-control": "no-store" } })
}
