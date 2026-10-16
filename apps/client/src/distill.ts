// Choix du distillateur : SDK Claude (clé API) → CLI `claude -p` → heuristique sans LLM.

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
import { brainHome, type Config } from "./config"

export type DistillerKind = "claude-api" | "claude-cli" | "heuristic"

export const DISTILLER_LABELS: Record<DistillerKind, string> = {
  "claude-api": "Claude (API Anthropic)",
  "claude-cli": "Claude Code en local (`claude -p`)",
  heuristic: "heuristique locale (sans LLM)",
}

export type DistillResult = { items: KnowledgeItemInput[]; used: DistillerKind; error?: string }

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
  return cliFlags
}

export function runClaudeCli(claudePath: string, prompt: string, timeoutMs = 120_000): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "json", "--model", "sonnet", ...detectCliFlags(claudePath)]
    let stdout = ""
    let stderr = ""
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const done = (r: { stdout: string; error?: string }) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    let child
    try {
      child = spawn(claudePath, args, {
        cwd: brainHome(),
        env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
        windowsHide: true,
      })
    } catch (err) {
      resolve({ stdout: "", error: (err as Error).message })
      return
    }
    timer = setTimeout(() => {
      child.kill("SIGTERM")
      done({ stdout, error: `délai de ${Math.round(timeoutMs / 1000)} s dépassé` })
    }, timeoutMs)
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
    child.on("error", (err) => done({ stdout, error: err.message }))
    child.on("close", (code) => done(code === 0 ? { stdout } : { stdout, error: `code ${code} ${truncate(stderr.trim() || stdout.trim(), 200)}` }))
    child.stdin.on("error", () => {})
    child.stdin.end(prompt)
  })
}

function heuristic(conv: Conversation, zones: ZoneHint[], fallbackZone: string): KnowledgeItemInput[] {
  return distillHeuristic(conv, zones, fallbackZone)
}

export async function createDistiller(cfg: Config, force?: DistillerKind): Promise<Distiller & { reason: string }> {
  const pick = pickDistiller(cfg, force)
  if (pick.kind === "claude-api") {
    const { createClaude, distillWithClaude } = await import("@brain/core/claude")
    const client = createClaude(apiKey(cfg))
    if (client) {
      return {
        kind: "claude-api",
        reason: pick.reason,
        concurrency: 3,
        async distill(conv, zones, fallbackZone) {
          try {
            const items = await distillWithClaude(client, conv, zones, fallbackZone)
            if (items) return { items: normalizeItems(items, conv, zones, fallbackZone), used: "claude-api" }
            return { items: heuristic(conv, zones, fallbackZone), used: "heuristic", error: "réponse Claude vide ou refusée" }
          } catch (err) {
            return { items: heuristic(conv, zones, fallbackZone), used: "heuristic", error: (err as Error).message }
          }
        },
      }
    }
  }
  if (pick.kind === "claude-cli" && pick.claudePath) {
    const claudePath = pick.claudePath
    return {
      kind: "claude-cli",
      reason: pick.reason,
      concurrency: 2,
      async distill(conv, zones, fallbackZone) {
        const { stdout, error } = await runClaudeCli(claudePath, buildCliExtractionPrompt(conv, zones))
        const items = error ? null : parseCliOutput(stdout, conv, zones, fallbackZone)
        if (items) return { items, used: "claude-cli" }
        return { items: heuristic(conv, zones, fallbackZone), used: "heuristic", error: error ?? "sortie de `claude -p` illisible" }
      },
    }
  }
  return {
    kind: "heuristic",
    reason: pick.kind === "heuristic" ? pick.reason : `${DISTILLER_LABELS[pick.kind]} indisponible`,
    concurrency: 8,
    async distill(conv, zones, fallbackZone) {
      return { items: heuristic(conv, zones, fallbackZone), used: "heuristic" }
    },
  }
}

/** Dernier filet de sécurité avant envoi : re-masquage et validation du contrat. */
export function finalizeItems(items: KnowledgeItemInput[]): KnowledgeItemInput[] {
  const seen = new Set<string>()
  const out: KnowledgeItemInput[] = []
  for (const i of items) {
    const parsed = KnowledgeItemInputSchema.safeParse({ ...i, title: redactText(i.title), body: redactText(i.body) })
    if (!parsed.success) continue
    const key = `${parsed.data.zone}:${parsed.data.kind}:${parsed.data.title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(parsed.data)
  }
  return out
}
