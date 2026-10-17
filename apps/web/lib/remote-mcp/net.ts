// Requêtes HTTP vers les serveurs MCP et leurs serveurs d'autorisation, avec la même protection SSRF que le
// récupérateur de l'onboarding (adresse vérifiée à la connexion, chaque redirection revérifiée), un délai et une
// taille bornés. `until` coupe la lecture dès que la réponse attendue est arrivée (flux SSE laissés ouverts).

import http from "node:http"
import https from "node:https"
import zlib from "node:zlib"
import { DEFAULT_DEPS, checkUrl, guardedLookup, type ScrapeDeps } from "../scrape"

export type NetDeps = ScrapeDeps

// Certains fournisseurs (Cloudflare devant) refusent les agents utilisateur inconnus.
const USER_AGENT = "Mozilla/5.0 (compatible; NOSBrainer/0.1; +https://www.nos-brainer.tech)"
const TIMEOUT_MS = 15_000
const MAX_BYTES = 1_000_000

export type HttpResult = { status: number; headers: Record<string, string>; body: string; truncated: boolean }

export type RequestOpts = {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
  /** Arrête la lecture dès que le corps reçu suffit. */
  until?: (body: string) => boolean
  /** Redirections suivies (GET seulement ; par défaut 3). */
  redirects?: number
}

function once(url: URL, opts: RequestOpts, deps: NetDeps, deadline: number): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    let settled = false
    const done = (err: Error | null, res?: HttpResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(res!)
    }
    const mod = url.protocol === "https:" ? https : http
    const maxBytes = opts.maxBytes ?? MAX_BYTES
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: opts.method ?? "GET",
        agent: false,
        lookup: guardedLookup(deps) as never,
        headers: {
          "user-agent": USER_AGENT,
          "accept-encoding": "gzip, deflate, br",
          ...(opts.body !== undefined ? { "content-length": String(Buffer.byteLength(opts.body)) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v
        const encoding = (headers["content-encoding"] ?? "").toLowerCase()
        const stream: NodeJS.ReadableStream =
          encoding === "gzip" || encoding === "x-gzip"
            ? res.pipe(zlib.createGunzip())
            : encoding === "deflate"
              ? res.pipe(zlib.createInflate())
              : encoding === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : res
        const chunks: Buffer[] = []
        let size = 0
        const finish = (truncated: boolean) => done(null, { status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8"), truncated })
        stream.on("data", (chunk: Buffer) => {
          if (settled) return
          const room = maxBytes - size
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk)
          size += Math.min(chunk.length, room)
          if (size >= maxBytes) {
            finish(true)
            req.destroy()
          } else if (opts.until && opts.until(Buffer.concat(chunks).toString("utf8"))) {
            finish(false)
            req.destroy()
          }
        })
        stream.on("end", () => finish(false))
        stream.on("error", (err: Error) => done(err))
      },
    )
    const timer = setTimeout(() => req.destroy(new Error("délai dépassé")), Math.max(1, deadline - Date.now()))
    req.on("error", (err) => done(err))
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

/** Requête protégée ; ne lève que pour une erreur réseau ou une adresse refusée (les statuts HTTP sont renvoyés). */
export async function guardedRequest(raw: string, opts: RequestOpts = {}, deps: NetDeps = DEFAULT_DEPS): Promise<HttpResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? TIMEOUT_MS)
  const method = (opts.method ?? "GET").toUpperCase()
  let url = checkUrl(raw, deps)
  let res = await once(url, opts, deps, deadline)
  const max = method === "GET" ? (opts.redirects ?? 3) : 0
  for (let n = 0; n < max && res.status >= 300 && res.status < 400 && res.headers.location; n++) {
    url = checkUrl(new URL(res.headers.location, url).toString(), deps)
    res = await once(url, opts, deps, deadline)
  }
  return res
}

/** GET d'un document JSON ; null si absent, non JSON ou en erreur. */
export async function getJson(raw: string, deps: NetDeps = DEFAULT_DEPS): Promise<Record<string, unknown> | null> {
  try {
    const res = await guardedRequest(raw, { headers: { accept: "application/json" }, timeoutMs: 10_000 }, deps)
    if (res.status < 200 || res.status >= 300) return null
    const data = JSON.parse(res.body) as unknown
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}
