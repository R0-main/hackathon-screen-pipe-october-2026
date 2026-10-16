// Récupère le texte lisible des liens fournis à l'onboarding (site, docs publiques…).

import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export const MAX_PAGE_CHARS = 20000

function isPrivateAddress(ip: string): boolean {
  if (ip === "::1" || ip === "::" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true
  const m = ip.replace(/^::ffff:/, "").split(".").map(Number)
  if (m.length !== 4 || m.some((n) => Number.isNaN(n))) return false
  const [a, b] = m
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

/** Refuse les adresses internes (protection SSRF : l'onboarding ne doit lire que des pages publiques). */
async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("seuls http et https sont acceptés")
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("adresse interne refusée")
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
  if (addresses.some(isPrivateAddress)) throw new Error("adresse interne refusée")
  return url
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

export function htmlToText(html: string): { title: string; description: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "")
  const description = decodeEntities(
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ??
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1] ??
      "",
  )
  const text = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
  return { title, description, text }
}

export type ScrapedPage = { url: string; title: string; text: string; truncated: boolean; error?: string }

export async function scrapeUrl(raw: string): Promise<ScrapedPage> {
  try {
    // Redirections suivies à la main pour revérifier chaque destination.
    let url = await assertPublicUrl(raw)
    let res: Response | null = null
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: { "user-agent": "CompanyBrainOnboarding/0.1 (+hackathon)", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
      })
      const location = res.headers.get("location")
      if (res.status < 300 || res.status >= 400 || !location) break
      url = await assertPublicUrl(new URL(location, url).toString())
    }
    if (!res || !res.ok) return { url: raw, title: "", text: "", truncated: false, error: `HTTP ${res?.status ?? "?"}` }
    const body = (await res.text()).slice(0, 2_000_000)
    const type = res.headers.get("content-type") ?? ""
    const parsed = type.includes("html") ? htmlToText(body) : { title: url.hostname, description: "", text: body }
    const full = [parsed.description, parsed.text].filter(Boolean).join("\n")
    return { url: raw, title: parsed.title || url.hostname, text: full.slice(0, MAX_PAGE_CHARS), truncated: full.length > MAX_PAGE_CHARS }
  } catch (err) {
    return { url: raw, title: "", text: "", truncated: false, error: err instanceof Error ? err.message : String(err) }
  }
}
