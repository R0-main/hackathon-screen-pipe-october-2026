// Choix du distillateur : SDK Claude (clé API) → CLI `claude -p` → heuristique sans LLM.
// L'heuristique ne sert que si aucun LLM n'est disponible : un échec du LLM laisse la conversation pour plus tard.

import { AsyncLocalStorage } from "node:async_hooks"
import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import {
  ENTITY_TYPES,
  KnowledgeItemInputSchema,
  buildCliExtractionPrompt,
  classifyZones,
  distillHeuristic,
  redactText,
  truncate,
  type Conversation,
  type KnowledgeItemInput,
  type ZoneHint,
} from "@brain/core"
import { UserError, brainHome, type Config } from "./config"

export type DistillerKind = "claude-api" | "claude-cli" | "heuristic"

export const DISTILLER_LABELS: Record<DistillerKind, string> = {
  "claude-api": "Claude (API Anthropic)",
  "claude-cli": "Claude Code en local (`claude -p`)",
  heuristic: "heuristique locale (sans LLM)",
}

/**
 * Nature d'un échec du LLM. `auth` : Claude n'est plus connecté (jeton expiré ou révoqué, « Please run /login », clé
 * refusée) ; `outage` : panne du poste ou du service (CLI introuvable, réseau, quotas, surcharge). Ces deux-là touchent
 * toutes les conversations : aucun essai n'est décompté. `conversation` : échec sur cette entrée (refus, sortie
 * illisible, délai dépassé, erreur propre à la requête), décompté pour elle.
 */
export type FailureKind = "auth" | "outage" | "conversation"

/**
 * `failed` : le LLM n'a rien donné d'utilisable. Aucun item n'est produit et la conversation n'est pas marquée comme
 * traitée : elle sera redistillée à la prochaine synchro (jamais par l'heuristique).
 * `signature` : pour un échec sans réponse du modèle (délai, erreur), de quoi reconnaître « tous les appels échouent de
 * la même façon » (panne). Absente quand le modèle a répondu (refus, sortie illisible) : Claude fonctionne.
 */
export type DistillResult = {
  items: KnowledgeItemInput[]
  used: DistillerKind
  error?: string
  failed?: boolean
  failure?: FailureKind
  signature?: string
}

export type Failure = { error: string; failure: FailureKind; signature?: string }

// Motifs d'erreurs de la CLI ou de l'API (jamais appliqués à une réponse du modèle). Alternatives simples, temps linéaire.
const AUTH_FAILURE =
  /please run \/login|\/login\b|not logged in|oauth token|token (?:has )?expired|token (?:has been |was )?revoked|authentication_error|authentication failed|failed to authenticate|invalid api key|invalid bearer token|invalid x-api-key|unauthori[sz]ed|(?:api error|status|http)\W{0,3}401\b/i
const OUTAGE_FAILURE =
  /\b(?:ENOENT|EACCES|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|fetch failed|connection error|network error|socket hang up|overloaded|rate.?limit|usage limit|credit balance|quota|permission_error|(?:api error|status|http)\W{0,3}(?:403|429|5\d\d)\b/i

/** Classe un message d'erreur de la CLI `claude` ou de l'API : connexion perdue, panne générale, ou propre à la requête. */
export function classifyFailure(text: string): FailureKind {
  if (AUTH_FAILURE.test(text)) return "auth"
  if (OUTAGE_FAILURE.test(text)) return "outage"
  return "conversation"
}

/** Claude Code n'est plus connecté : quoi faire (affiché par sync et refresh-status). */
export function claudeAuthHelp(detail?: string): string {
  return (
    `Claude Code n'est plus connecté sur ce poste : le jeton Claude a expiré ou a été révoqué${detail ? ` (« ${truncate(detail, 160)} »)` : ""}. ` +
    "Lancez `claude setup-token`, puis `node ~/.company-brain/brain.mjs init --claude-token <jeton>` (ou `claude /login`)."
  )
}

/** Clé API refusée (distillation par le SDK). */
export function apiAuthHelp(detail?: string): string {
  return `Clé API Anthropic refusée${detail ? ` (« ${truncate(detail, 160)} »)` : ""} : vérifiez-la, ou remplacez-la avec \`init --anthropic-key <clé>\`.`
}

export type Distiller = {
  kind: DistillerKind
  concurrency: number
  distill(conv: Conversation, zones: ZoneHint[], fallbackZone: string): Promise<DistillResult>
}

/** Cherche un exécutable dans le PATH (gère PATHEXT sous Windows). */
export function findOnPath(cmd: string, pathEnv = process.env.PATH ?? ""): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").concat([""]) : [""]
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext.toLowerCase())
      try {
        if (!statSync(p).isFile()) continue
        if (process.platform !== "win32") accessSync(p, constants.X_OK)
        return p
      } catch {
        // suivant
      }
    }
  }
  return null
}

export function apiKey(cfg: Pick<Config, "anthropic_api_key">): string | undefined {
  return cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY || undefined
}

/** Quel distillateur serait utilisé, et pourquoi. */
export function pickDistiller(cfg: Pick<Config, "anthropic_api_key" | "use_claude_cli">, force?: DistillerKind): { kind: DistillerKind; reason: string; claudePath?: string } {
  const claudePath = findOnPath("claude") ?? undefined
  if (force === "heuristic") return { kind: "heuristic", reason: "forcé par --distiller" }
  if (force === "claude-api") return { kind: "claude-api", reason: "forcé par --distiller" }
  if (force === "claude-cli") return { kind: "claude-cli", reason: "forcé par --distiller", claudePath }
  if (apiKey(cfg)) return { kind: "claude-api", reason: cfg.anthropic_api_key ? "clé API dans la config" : "ANTHROPIC_API_KEY définie" }
  if (cfg.use_claude_cli !== false && claudePath) return { kind: "claude-cli", reason: `CLI trouvée (${claudePath})`, claudePath }
  return {
    kind: "heuristic",
    reason: cfg.use_claude_cli === false ? "CLI Claude désactivée (use_claude_cli: false) et pas de clé API" : "ni clé API ni CLI `claude` dans le PATH",
  }
}

/** Extrait le premier objet JSON d'un texte (tolère blocs de code et texte autour). */
export function extractJsonObject(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, "").trim()
  try {
    return JSON.parse(t)
  } catch {
    // on cherche l'objet le plus large
  }
  const start = t.indexOf("{")
  const end = t.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch {
    return null
  }
}

/** Valide et complète les items renvoyés par un LLM (source, zone connue, bornes). */
export function normalizeItems(raw: unknown, conv: Conversation, zones: ZoneHint[], fallbackZone: string): KnowledgeItemInput[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items : []
  const zoneIds = new Set(zones.map((z) => z.id))
  const source = { app: conv.app, tool: conv.tool, at: conv.ended_at, session_id: conv.id, ...(conv.screenpipe_ref ? { screenpipe_ref: conv.screenpipe_ref } : {}) }
  const out: KnowledgeItemInput[] = []
  for (const r of list.slice(0, 6)) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    const title = typeof o.title === "string" ? truncate(o.title.trim(), 140) : ""
    const body = typeof o.body === "string" ? truncate(o.body.trim(), 2000) : ""
    const zone = typeof o.zone === "string" && zoneIds.has(o.zone) ? o.zone : (classifyZones(`${title} ${body}`, zones, 1)[0] ?? fallbackZone)
    const entities = (Array.isArray(o.entities) ? (o.entities as { type?: unknown; name?: unknown }[]) : [])
      .filter((e) => e && (ENTITY_TYPES as readonly unknown[]).includes(e.type) && typeof e.name === "string" && e.name.trim())
      .map((e) => ({ type: e.type, name: truncate(String(e.name).trim(), 120) }))
      .slice(0, 10)
    const confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : 0.6
    const parsed = KnowledgeItemInputSchema.safeParse({ zone, kind: o.kind, title, body, entities, source, confidence })
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/** Analyse la sortie de `claude -p --output-format json` ({ result: "…" }). */
export function parseCliOutput(stdout: string, conv: Conversation, zones: ZoneHint[], fallbackZone: string): KnowledgeItemInput[] | null {
  const envelope = extractJsonObject(stdout) as { result?: unknown; is_error?: boolean } | null
  if (!envelope || envelope.is_error) return null
  const inner = typeof envelope.result === "string" ? extractJsonObject(envelope.result) : "items" in envelope ? envelope : null
  if (!inner || typeof inner !== "object") return null
  return normalizeItems(inner, conv, zones, fallbackZone)
}

/** Résultat d'un `claude -p` : sortie standard, ou erreur (lancement impossible, délai dépassé, code de sortie non nul). */
export type ClaudeCliRun = { stdout: string; error?: string; failure?: FailureKind; signature?: string }

/** Texte d'erreur lisible d'une CLI qui a échoué : stderr, sinon le champ `result` de l'enveloppe JSON, sinon stdout. */
function cliErrorText(stdout: string, stderr: string): string {
  if (stderr.trim()) return stderr.trim()
  const envelope = extractJsonObject(stdout) as { result?: unknown } | null
  return typeof envelope?.result === "string" ? envelope.result.trim() : stdout.trim()
}

/**
 * Échec d'un `claude -p` (processus, délai, ou enveloppe `is_error` avec un code 0), ou null si la CLI a répondu.
 * Une réponse du modèle qui n'est pas du JSON exploitable n'est pas traitée ici (c'est un échec propre à l'entrée).
 */
export function cliFailure(run: ClaudeCliRun): Failure | null {
  if (run.error) return { error: run.error, failure: run.failure ?? classifyFailure(run.error), ...(run.signature ? { signature: run.signature } : {}) }
  const envelope = extractJsonObject(run.stdout) as { result?: unknown; is_error?: unknown } | null
  if (envelope?.is_error !== true) return null
  const text = typeof envelope.result === "string" && envelope.result.trim() ? envelope.result.trim() : "erreur sans détail"
  const failure = classifyFailure(text)
  const error = truncate(text, 200)
  return failure === "conversation" ? { error, failure, signature: truncate(text, 160) } : { error, failure }
}

let cliFlags: string[] | null = null

/** Options facultatives selon la version de la CLI : pas de session enregistrée, aucun outil. */
function detectCliFlags(claudePath: string): string[] {
  if (cliFlags) return cliFlags
  const help = spawnSync(claudePath, ["--help"], { encoding: "utf8", timeout: 8000, shell: process.platform === "win32", env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" } })
  const text = `${help.stdout ?? ""}${help.stderr ?? ""}`
  cliFlags = []
  if (text.includes("--no-session-persistence")) cliFlags.push("--no-session-persistence")
  // `--tools ""` (aucun outil) : pas sous Windows, où le shell perdrait l'argument vide.
  if (/--tools\b/.test(text) && process.platform !== "win32") cliFlags.push("--tools", "")
  // Jamais `--bare` : ce mode ignore CLAUDE_CODE_OAUTH_TOKEN (le jeton de `init --claude-token`), même si la CLI le propose.
  return cliFlags
}

/** Arguments de chaque `claude -p` (exportés pour les tests : jamais `--bare`). */
export function claudeCliArgs(claudePath: string): string[] {
  return ["-p", "--output-format", "json", "--model", "sonnet", ...detectCliFlags(claudePath)].filter((a) => a !== "--bare")
}

export type ClaudeCliOptions = {
  /** Jeton longue durée (`claude setup-token`, config claude_oauth_token) : transmis en CLAUDE_CODE_OAUTH_TOKEN. */
  oauthToken?: string
}

/** Environnement de chaque `claude -p` : session marquée interne (nos hooks l'ignorent), jeton Claude Code si configuré. */
export function claudeCliEnv(opts: ClaudeCliOptions = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, COMPANY_BRAIN_INTERNAL: "1" }
  const token = opts.oauthToken?.trim()
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
  return env
}

/** Options de `claude -p` tirées de la config. */
export function claudeCliOptions(cfg: Partial<Pick<Config, "claude_oauth_token">> | null | undefined): ClaudeCliOptions {
  return cfg?.claude_oauth_token ? { oauthToken: cfg.claude_oauth_token } : {}
}

/** Ne laisse jamais le jeton Claude Code apparaître dans un message d'erreur. */
function hideToken(s: string, opts: ClaudeCliOptions): string {
  const t = opts.oauthToken?.trim()
  return t && t.length >= 8 ? s.split(t).join("[jeton masqué]") : s
}

export function runClaudeCli(claudePath: string, prompt: string, timeoutMs = 120_000, opts: ClaudeCliOptions = {}): Promise<ClaudeCliRun> {
  return new Promise((resolve) => {
    const args = claudeCliArgs(claudePath)
    let stdout = ""
    let stderr = ""
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const done = (r: ClaudeCliRun) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r.error ? { ...r, error: hideToken(r.error, opts) } : r)
    }
    let child
    try {
      child = spawn(claudePath, args, {
        cwd: brainHome(),
        env: claudeCliEnv(opts),
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
        windowsHide: true,
      })
    } catch (err) {
      done({ stdout: "", error: `lancement de \`claude\` impossible : ${(err as Error).message}`, failure: "outage" })
      return
    }
    timer = setTimeout(() => {
      child.kill("SIGTERM")
      // Délai dépassé : propre à cette entrée, sauf si tous les appels de la synchro finissent pareil (panne).
      done({ stdout, error: `délai de ${Math.round(timeoutMs / 1000)} s dépassé`, failure: "conversation", signature: "délai dépassé" })
    }, timeoutMs)
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
    child.on("error", (err) => done({ stdout, error: `lancement de \`claude\` impossible : ${err.message}`, failure: "outage" }))
    child.on("close", (code) => {
      if (code === 0) return done({ stdout })
      const text = cliErrorText(stdout, stderr)
      // Classé sur le texte d'erreur (stderr, champ `result`), pas sur l'enveloppe brute (durées, jetons…).
      const failure = classifyFailure(`${stderr}\n${text}`)
      const error = `code ${code}${text ? ` : ${truncate(text, 200)}` : ""}`
      done(failure === "conversation" ? { stdout, error, failure, signature: truncate(hideToken(text, opts), 160) || `code ${code}` } : { stdout, error, failure })
    })
    child.stdin.on("error", () => {})
    child.stdin.end(prompt)
  })
}

function heuristic(conv: Conversation, zones: ZoneHint[], fallbackZone: string): KnowledgeItemInput[] {
  return distillHeuristic(conv, zones, fallbackZone)
}

type HttpTrace = { status?: number; body?: string; network?: string; thrown?: string }
const httpTrace = new AsyncLocalStorage<HttpTrace>()

/** fetch du SDK Anthropic : note, pour l'appel en cours (AsyncLocalStorage), le dernier statut HTTP ou l'erreur réseau. */
const tracedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const trace = httpTrace.getStore()
  try {
    const res = await fetch(input, init)
    if (trace) {
      trace.status = res.status
      trace.network = undefined
      trace.body = res.ok ? undefined : await res.clone().text().then((t) => t.slice(0, 400), () => "")
    }
    return res
  } catch (err) {
    if (trace) trace.network = (err as Error).message
    throw err
  }
}

/** Échec d'une distillation par l'API, d'après le dernier appel HTTP. */
export function apiFailure(trace: { status?: number; body?: string; network?: string; thrown?: string }): Failure {
  if (trace.network) return { error: `API Anthropic injoignable : ${truncate(trace.network, 160)}`, failure: "outage" }
  const s = trace.status
  if (s === undefined) return { error: `aucune réponse de l'API${trace.thrown ? ` : ${truncate(trace.thrown, 160)}` : ""}`, failure: "conversation", signature: "sans réponse" }
  // Le modèle a répondu (refus, sortie hors schéma) : Claude fonctionne, l'échec tient à cette conversation.
  if (s >= 200 && s < 300) return { error: "réponse Claude vide, refusée ou hors format", failure: "conversation" }
  const detail = `HTTP ${s}${trace.body ? ` ${truncate(trace.body.replace(/\s+/g, " "), 160)}` : ""}`
  if (s === 401) return { error: `API Anthropic : ${detail}`, failure: "auth" }
  if (s === 403 || s === 408 || s === 429 || s >= 500) return { error: `API Anthropic : ${detail}`, failure: "outage" }
  const failure = classifyFailure(trace.body ?? "")
  return failure === "conversation" ? { error: `API Anthropic : ${detail}`, failure, signature: `HTTP ${s}` } : { error: `API Anthropic : ${detail}`, failure }
}

export async function createDistiller(cfg: Config, force?: DistillerKind): Promise<Distiller & { reason: string }> {
  const pick = pickDistiller(cfg, force)
  if (pick.kind === "claude-api") {
    const key = apiKey(cfg)
    if (key || process.env.ANTHROPIC_AUTH_TOKEN) {
      const { distillWithClaude } = await import("@brain/core/claude")
      const { default: Anthropic } = await import("@anthropic-ai/sdk")
      // Statut HTTP de chaque appel (via un fetch instrumenté) : distingue clé refusée, panne et refus du modèle.
      const client = new Anthropic({ ...(key ? { apiKey: key } : {}), fetch: tracedFetch })
      return {
        kind: "claude-api",
        reason: pick.reason,
        concurrency: 3,
        async distill(conv, zones, fallbackZone) {
          const trace: HttpTrace = {}
          try {
            const items = await httpTrace.run(trace, () => distillWithClaude(client, conv, zones, fallbackZone))
            if (items) return { items: normalizeItems(items, conv, zones, fallbackZone), used: "claude-api" }
          } catch (err) {
            trace.thrown = (err as Error).message
          }
          return { items: [], used: "claude-api", failed: true, ...apiFailure(trace) }
        },
      }
    }
    if (force === "claude-api") throw new UserError("--distiller claude-api : aucune clé API (init --anthropic-key <clé> ou ANTHROPIC_API_KEY).")
  }
  if (pick.kind === "claude-cli" && pick.claudePath) {
    const claudePath = pick.claudePath
    const cliOpts = claudeCliOptions(cfg)
    return {
      kind: "claude-cli",
      reason: pick.reason + (cliOpts.oauthToken ? ", jeton Claude Code de la config" : ""),
      concurrency: 2,
      async distill(conv, zones, fallbackZone) {
        const run = await runClaudeCli(claudePath, buildCliExtractionPrompt(conv, zones), 120_000, cliOpts)
        const fail = cliFailure(run)
        if (fail) return { items: [], used: "claude-cli", failed: true, ...fail }
        const items = parseCliOutput(run.stdout, conv, zones, fallbackZone)
        if (items) return { items, used: "claude-cli" }
        // Le modèle a répondu, mais pas en JSON exploitable (refus, prose) : échec propre à cette conversation.
        return { items: [], used: "claude-cli", failed: true, failure: "conversation", error: "sortie de `claude -p` illisible : refus ou réponse hors format" }
      },
    }
  }
  if (force === "claude-cli") throw new UserError("--distiller claude-cli : CLI `claude` introuvable dans le PATH.")
  return {
    kind: "heuristic",
    reason: pick.kind === "heuristic" ? pick.reason : `${DISTILLER_LABELS[pick.kind]} indisponible`,
    concurrency: 8,
    async distill(conv, zones, fallbackZone) {
      return { items: heuristic(conv, zones, fallbackZone), used: "heuristic" }
    },
  }
}

/**
 * Dernier filet de sécurité avant envoi : re-masquage (avec les secrets du poste, pris tels quels) et validation du contrat.
 * `seen` : dédoublonnage partagé entre appels.
 */
export function finalizeItems(items: KnowledgeItemInput[], seen = new Set<string>(), literals: string[] = []): KnowledgeItemInput[] {
  const out: KnowledgeItemInput[] = []
  for (const i of items) {
    const parsed = KnowledgeItemInputSchema.safeParse({ ...i, title: redactText(i.title, { literals }), body: redactText(i.body, { literals }) })
    if (!parsed.success) continue
    const key = `${parsed.data.zone}:${parsed.data.kind}:${parsed.data.title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(parsed.data)
  }
  return out
}
