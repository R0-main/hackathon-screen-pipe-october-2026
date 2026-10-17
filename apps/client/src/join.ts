// `brain.mjs join` : rejoindre une entreprise avec le message d'équipe (un code par entreprise, pas de jeton personnel).
// Le jeton du poste est généré ici et seule son empreinte part avec la demande ; le poste attend qu'un admin l'accepte
// (POST /api/join/status), puis enchaîne sur `setup` avec ce jeton (et rend son code). Sans réponse à temps : code 7, et
// `join` sans paramètres reprend la même demande (état dans ~/.company-brain/join.json, mode 600).

import { createHash, randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { brainHome, ensureHome, readJson, UserError, writeJson } from "./config"
import { applyCa, readCaFile } from "./ca"

type Log = (s: string) => void

// Après ceux des scripts d'installation et de setup (5 : téléchargement raté, 6 : branché sans Screenpipe) : un code,
// un sens, quelle que soit la commande qui l'a rendu.
export const EXIT_JOIN_PENDING = 7
export const EXIT_JOIN_REJECTED = 8
export const DEFAULT_ACCEPT_WAIT_S = 480

type JoinState = { url: string; id: string; token: string; org: string; name?: string }

export const joinStatePath = () => join(brainHome(), "join.json")

export type JoinDeps = {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  /** Suite une fois la demande acceptée (par défaut : `setup --url --token`). */
  setup?: (flags: Record<string, string | boolean>, log: Log) => Promise<number>
}

/** Options de `join` qui ne regardent pas `setup` (le reste, --audio, --wait, --no-open…, lui est transmis). */
const JOIN_ONLY = ["join", "code", "name", "title", "email", "wait-accept", "url", "token"]

async function post<T>(f: typeof fetch, url: string, path: string, body: unknown): Promise<{ status: number; data: T & { error?: string } }> {
  let res: Response
  try {
    res = await f(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new UserError(`Impossible de joindre le cerveau (${url}) : ${(err as Error).message}`)
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  return { status: res.status, data }
}

export async function cmdJoin(flags: Record<string, string | boolean>, log: Log = console.log, deps: JoinDeps = {}): Promise<number> {
  const f = deps.fetch ?? fetch
  // Cerveau auto-hébergé : la demande part en HTTPS vers son certificat avant toute config.
  if (typeof flags.ca === "string" && flags.ca.trim()) applyCa(readCaFile(flags.ca.trim()).certs)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string).trim() : undefined)
  const waitS = str("wait-accept") !== undefined ? Number.parseInt(str("wait-accept")!, 10) : DEFAULT_ACCEPT_WAIT_S
  if (!(waitS >= 0)) throw new UserError("--wait-accept : un nombre de secondes.")

  const code = str("join") ?? str("code")
  const url = str("url")?.replace(/\/+$/, "")
  let state = readJson<JoinState>(joinStatePath())

  if (code) {
    if (!url) throw new UserError("Usage : join --url <adresse du cerveau> --join <code d'équipe> [--name …] [--title …] [--email …]")
    // Même cerveau, demande déjà faite : on la reprend plutôt que d'en créer une seconde.
    if (!state || state.url !== url) {
      const token = `cb_${randomBytes(24).toString("base64url")}`
      const token_hash = createHash("sha256").update(token).digest("hex")
      const fields = { name: str("name"), title: str("title"), email: str("email"), hostname: hostname().replace(/\.local$/, "") }
      const r = await post<{ id: string; org: string }>(f, url, "/api/join", { code, token_hash, ...fields })
      if (r.status !== 201) throw new UserError(`Demande refusée par le cerveau (${r.status}) : ${r.data.error ?? "réponse inattendue"}`)
      state = { url, id: r.data.id, token, org: r.data.org, name: fields.name }
      ensureHome()
      writeJson(joinStatePath(), state, 0o600)
      log(`Demande envoyée à ${state.org}${fields.name ? ` au nom de ${fields.name}` : ""} : un admin doit l'accepter (Équipe et accès).`)
    } else log(`Demande déjà envoyée à ${state.org} : on attend toujours qu'un admin l'accepte.`)
  } else if (!state) {
    throw new UserError("Aucune demande en cours : lancez le message d'équipe (join --url <adresse> --join <code>).")
  } else log(`Reprise de la demande envoyée à ${state.org}.`)

  const deadline = Date.now() + waitS * 1000
  let lastNote = Date.now()
  for (;;) {
    const r = await post<{ status: string; org: string }>(f, state.url, "/api/join/status", { id: state.id, token: state.token })
    if (r.status === 404) {
      rmSync(joinStatePath(), { force: true })
      throw new UserError("Le cerveau ne connaît plus cette demande : relancez le message d'équipe.")
    }
    if (r.status !== 200) throw new UserError(`Le cerveau a répondu ${r.status}${r.data.error ? ` : ${r.data.error}` : ""}.`)
    if (r.data.status === "accepted") {
      log(`Demande acceptée par ${state.org}. Installation du poste.`)
      const rest = Object.fromEntries(Object.entries(flags).filter(([k]) => !JOIN_ONLY.includes(k)))
      const setup = deps.setup ?? (async (fl, lg) => (await import("./setup")).cmdSetup(fl, lg))
      const out = await setup({ ...rest, url: state.url, token: state.token }, log)
      // Le jeton est maintenant dans config.json (cmdInit) : l'état de la demande ne sert plus.
      rmSync(joinStatePath(), { force: true })
      return out
    }
    if (r.data.status === "rejected") {
      rmSync(joinStatePath(), { force: true })
      log(`REFUSÉE : ${state.org} n'a pas accepté la demande. Rien n'a été installé.`)
      return EXIT_JOIN_REJECTED
    }
    if (Date.now() >= deadline) {
      log(`EN ATTENTE D'ACCEPTATION : un admin de ${state.org} doit accepter la demande (Équipe et accès, puis Demandes). Relancez ensuite \`join\` : il reprend la même demande.`)
      return EXIT_JOIN_PENDING
    }
    if (Date.now() - lastNote >= 60_000) {
      lastNote = Date.now()
      log(`Toujours en attente d'un admin (encore ${Math.round((deadline - Date.now()) / 1000)} s).`)
    }
    await sleep(deps.pollMs ?? 3000)
  }
}
