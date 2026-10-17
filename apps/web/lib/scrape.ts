// Récupère le texte lisible des liens fournis à l'onboarding (site, docs publiques…).
//
// Protection SSRF : l'adresse est vérifiée AU MOMENT DE LA CONNEXION (lookup personnalisé de node:http/https),
// pas par une résolution DNS séparée que fetch referait ensuite (rebinding DNS). Les adresses sont analysées octet
// par octet (IPv4, IPv6, IPv4 mappée, NAT64, 6to4…) ; chaque redirection est revérifiée ; taille et durée bornées.

import http from "node:http"
import https from "node:https"
import { lookup as dnsLookup, type LookupAddress } from "node:dns"
import { isIP } from "node:net"
import zlib from "node:zlib"

export const MAX_PAGE_CHARS = 20000
const MAX_BYTES = 2_000_000
const HOP_TIMEOUT_MS = 8_000
const TOTAL_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 4
const USER_AGENT = "CompanyBrainOnboarding/0.1 (+hackathon)"

function parseIPv4(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const bytes = m.slice(1).map(Number)
  return bytes.every((n) => n <= 255) ? bytes : null
}

/** IPv6 → 16 octets (formes compressées, IPv4 finale en notation pointée, zone %eth0 ignorée). */
function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const b = parseIPv4(dotted[2])
    if (!b) return null
    s = `${dotted[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`
  }
  const halves = s.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail]
  const bytes: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    const n = parseInt(g, 16)
    bytes.push(n >> 8, n & 0xff)
  }
  return bytes
}

function isBlockedIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // « ce réseau »
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // lien local (métadonnées cloud)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) || // relais 6to4
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // bancs de test
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, réservé, diffusion
  )
}

function isBlockedIPv6(x: number[]): boolean {
  const zero = (from: number, to: number) => x.slice(from, to).every((n) => n === 0)
  if (zero(0, 12)) return true // ::, ::1, IPv4 compatible (obsolète)
  if (zero(0, 10) && x[10] === 0xff && x[11] === 0xff) return isBlockedIPv4(x.slice(12)) // IPv4 mappée ::ffff:a.b.c.d
  if (zero(0, 8) && x[8] === 0xff && x[9] === 0xff && zero(10, 12)) return true // IPv4 traduite ::ffff:0:a.b.c.d
  if (x[0] === 0 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b) {
    if (zero(4, 12)) return isBlockedIPv4(x.slice(12)) // NAT64 64:ff9b::/96
    return true // NAT64 local 64:ff9b:1::/48 et voisins
  }
  if (x[0] === 0x20 && x[1] === 0x02) return isBlockedIPv4(x.slice(2, 6)) // 6to4 2002::/16 : IPv4 embarquée
  if ((x[0] & 0xe0) !== 0x20) return true // hors unicast global 2000::/3 : ULA fc00::/7, lien local fe80::/10, site fec0::/10, multicast…
  if (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0x00 && x[3] < 0x02) return true // 2001::/23 (Teredo, ORCHID, bancs de test)
  if (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0x0d && x[3] === 0xb8) return true // documentation 2001:db8::/32
  if (x[0] === 0x3f && x[1] === 0xff && x[2] < 0x10) return true // documentation 3fff::/20
  return false
}

/** Vrai si l'adresse IP n'est pas une adresse publique joignable (ou illisible). */
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseIPv4(ip)
  if (v4) return isBlockedIPv4(v4)
  const v6 = parseIPv6(ip)
  return v6 ? isBlockedIPv6(v6) : true
}

export type Resolved = { address: string; family: number }
export type ScrapeDeps = {
  /** Résolution DNS (par défaut : dns.lookup du système, toutes les adresses). */
  resolve: (host: string) => Promise<Resolved[]>
  /** Adresses refusées (par défaut : isBlockedAddress). */
  isBlocked: (ip: string) => boolean
}

const systemResolve = (host: string) =>
  new Promise<Resolved[]>((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs as LookupAddress[]))),
  )

const DEFAULT_DEPS: ScrapeDeps = { resolve: systemResolve, isBlocked: isBlockedAddress }

class BlockedError extends Error {
  constructor() {
    super("adresse interne refusée")
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/** Lookup utilisé par le socket lui-même : l'adresse vérifiée est celle à laquelle on se connecte. */
function guardedLookup(deps: ScrapeDeps) {
  return (hostname: string, options: { family?: number | string; all?: boolean }, callback: LookupCallback) => {
    deps.resolve(hostname).then(
      (addrs) => {
        if (addrs.length === 0) return callback(Object.assign(new Error(`aucune adresse pour ${hostname}`), { code: "ENOTFOUND" }), "", 0)
        // Une seule adresse interne suffit à refuser (un attaquant peut mélanger public et privé).
        if (addrs.some((a) => deps.isBlocked(a.address))) return callback(new BlockedError(), "", 0)
        const family = options.family === 4 || options.family === "IPv4" ? 4 : options.family === 6 || options.family === "IPv6" ? 6 : 0
        const wanted = family ? addrs.filter((a) => a.family === family) : addrs
        if (wanted.length === 0) return callback(Object.assign(new Error(`aucune adresse IPv${family} pour ${hostname}`), { code: "ENOTFOUND" }), "", 0)
        if (options.all) callback(null, wanted.map((a) => ({ address: a.address, family: a.family })))
        else callback(null, wanted[0].address, wanted[0].family)
      },
      (err) => callback(err as NodeJS.ErrnoException, "", 0),
    )
  }
}

/** Refuse les URL non http(s) et les noms ou IP littérales internes (les noms DNS sont revérifiés à la connexion). */
function checkUrl(raw: string, deps: ScrapeDeps): URL {
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("seuls http et https sont acceptés")
  if (url.username || url.password) throw new Error("identifiants dans l'URL refusés")
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase()
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new BlockedError()
  // Une IP littérale ne passe pas par le lookup : on la vérifie ici.
  if (isIP(host) && deps.isBlocked(host)) throw new BlockedError()
  return url
}

type Hop = { status: number; location?: string; contentType: string; body?: string; truncated: boolean }

function decode(buf: Buffer, contentType: string): string {
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1]
  try {
    return new TextDecoder(charset || "utf-8").decode(buf)
  } catch {
    return new TextDecoder("utf-8").decode(buf)
  }
}

function requestOnce(url: URL, deps: ScrapeDeps, deadline: number): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    let settled = false
    const done = (err: Error | null, hop?: Hop) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(hop!)
    }
    const mod = url.protocol === "https:" ? https : http
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        lookup: guardedLookup(deps) as never,
        timeout: HOP_TIMEOUT_MS,
        headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain;q=0.9,*/*;q=0.5", "accept-encoding": "gzip, deflate, br" },
      },
      (res) => {
        const status = res.statusCode ?? 0
        const contentType = String(res.headers["content-type"] ?? "")
        const location = res.headers.location
        if ((status >= 300 && status < 400) || status < 200 || status >= 300) {
          res.resume()
          return done(null, { status, location, contentType, truncated: false })
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase()
        const body: NodeJS.ReadableStream =
          encoding === "gzip" || encoding === "x-gzip"
            ? res.pipe(zlib.createGunzip())
            : encoding === "deflate"
              ? res.pipe(zlib.createInflate())
              : encoding === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : res
        const chunks: Buffer[] = []
        let size = 0
        const finish = (truncated: boolean) => done(null, { status, contentType, body: decode(Buffer.concat(chunks), contentType), truncated })
        body.on("data", (chunk: Buffer) => {
          if (settled) return
          const room = MAX_BYTES - size
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk)
          size += Math.min(chunk.length, room)
          // Taille bornée (après décompression) : on coupe la connexion.
          if (size >= MAX_BYTES) {
            finish(true)
            req.destroy()
          }
        })
        body.on("end", () => finish(false))
        body.on("error", (err: Error) => done(err))
      },
    )
    const timer = setTimeout(() => req.destroy(new Error("délai dépassé")), Math.max(1, Math.min(deadline - Date.now(), HOP_TIMEOUT_MS)))
    req.on("timeout", () => req.destroy(new Error("délai dépassé")))
    req.on("error", (err) => done(err))
    req.end()
  })
}

const TEXT_TYPES = /html|text\/|xml|json|calendar/i

export type ScrapedPage = { url: string; title: string; text: string; truncated: boolean; error?: string }

/** Comme scrapeUrl, avec une résolution DNS et une liste d'adresses refusées injectables (tests). */
export async function scrapeUrlWith(raw: string, deps: ScrapeDeps, opts: { maxChars?: number } = {}): Promise<ScrapedPage> {
  const maxChars = opts.maxChars ?? MAX_PAGE_CHARS
  try {
    const deadline = Date.now() + TOTAL_TIMEOUT_MS
    // Redirections suivies à la main pour revérifier chaque destination.
    let url = checkUrl(raw, deps)
    let hop = await requestOnce(url, deps, deadline)
    for (let n = 0; hop.status >= 300 && hop.status < 400 && hop.location; n++) {
      if (n >= MAX_REDIRECTS) return { url: raw, title: "", text: "", truncated: false, error: "trop de redirections" }
      url = checkUrl(new URL(hop.location, url).toString(), deps)
      hop = await requestOnce(url, deps, deadline)
    }
    if (hop.status < 200 || hop.status >= 300 || hop.body === undefined) return { url: raw, title: "", text: "", truncated: false, error: `HTTP ${hop.status || "?"}` }
    if (hop.contentType && !TEXT_TYPES.test(hop.contentType)) return { url: raw, title: "", text: "", truncated: false, error: `type de contenu non pris en charge (${hop.contentType.split(";")[0]})` }
    const parsed = /html/i.test(hop.contentType) ? htmlToText(hop.body) : { title: url.hostname, description: "", text: hop.body }
    const full = [parsed.description, parsed.text].filter(Boolean).join("\n")
    return { url: raw, title: parsed.title || url.hostname, text: full.slice(0, maxChars), truncated: hop.truncated || full.length > maxChars }
  } catch (err) {
    return { url: raw, title: "", text: "", truncated: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function scrapeUrl(raw: string, opts: { maxChars?: number } = {}): Promise<ScrapedPage> {
  return scrapeUrlWith(raw, DEFAULT_DEPS, opts)
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

