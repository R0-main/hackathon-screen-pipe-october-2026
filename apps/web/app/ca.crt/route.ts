import { brainCa } from "@/lib/ca"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Certificat de l'autorité privée d'un cerveau auto-hébergé (à vérifier par son empreinte, donnée dans le prompt). */
export async function GET() {
  const ca = brainCa()
  if (!ca) return new Response("Ce cerveau n'a pas de certificat privé.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
  return new Response(ca.pem, { headers: { "content-type": "application/x-pem-file", "cache-control": "no-store" } })
}
