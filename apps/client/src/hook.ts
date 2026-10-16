// Hook Claude Code (SessionStart, UserPromptSubmit, Stop) : rapide, silencieux, ne casse jamais Claude Code.

import { appendFileSync } from "node:fs"
import { classifyZones, looksPersonal, promptFingerprint, redactText, truncate, type AgentEventInput } from "@brain/core"
import { BrainApi } from "./api"
import { firstName, zoneName } from "./cache"
import { loadCache, loadConfig, paths, type Cache } from "./config"
import { isBrainSetupText, maskOwnSecrets, ownSecrets } from "./secrets"

export const HOOK_GLOBAL_TIMEOUT_MS = 2500
export const HOOK_NETWORK_TIMEOUT_MS = 1500

export type HookInput = {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  prompt?: string
  source?: string
}

function logHookError(err: unknown) {
  try {
    appendFileSync(paths.log(), `[${new Date().toISOString()}] hook : ${(err as Error)?.message ?? String(err)}\n`)
  } catch {
    // tant pis
  }
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("")
    let data = ""
    const finish = () => {
      clearTimeout(timer)
      process.stdin.removeAllListeners()
      process.stdin.pause()
      resolve(data)
    }
    const timer = setTimeout(finish, timeoutMs)
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (d) => (data += d))
    process.stdin.on("end", finish)
    process.stdin.on("error", finish)
  })
}

/** La ligne de contexte injectée par SessionStart dans la session Claude Code. */
export function sessionStartLine(cache: Cache | null): string {
  const who = cache?.whoami
  const zones = who?.readable?.length ? who.readable.map((z) => zoneName(cache, z)).join(", ") : "aucune pour l'instant"
  const org = who?.org ? ` de ${who.org}` : ""
  const access = who ? ` (${firstName(who.name)} peut lire les zones : ${zones})` : ""
  return (
    `Cerveau d'entreprise${org} connecté${access}. ` +
    `Pour tout contexte d'entreprise (décisions, procédures, clients, projets, outils, qui fait quoi), ` +
    `utilise l'outil MCP search_brain du serveur company-brain avant de deviner ; remember pour y enregistrer une décision ou une procédure importante.`
  )
}

export type HookOptions = {
  /** `share_prompt_summaries` de la config : false → jamais de résumé de prompt. */
  shareSummaries?: boolean
  /** Secrets du poste (jeton du cerveau…), masqués et signe d'une session d'installation. */
  secrets?: string[]
}

/**
 * Construit l'événement à envoyer, ou null si l'événement est ignoré.
 * UserPromptSubmit : le résumé (160 caractères masqués) ne part que si le prompt se rattache à au moins une zone
 * et n'a rien de personnel ; sinon l'événement part sans résumé (empreinte seule, ou rien pour un prompt perso).
 */
export function eventForHook(input: HookInput, cache: Cache | null, opts: HookOptions = {}): AgentEventInput | null {
  const session_id = input.session_id ? String(input.session_id).slice(0, 200) : undefined
  switch (input.hook_event_name) {
    case "SessionStart":
      return { agent: "claude-code", type: "started", session_id }
    case "Stop":
      return { agent: "claude-code", type: "stopped", session_id }
    case "UserPromptSubmit": {
      const prompt = (input.prompt ?? "").trim()
      if (!prompt) return null
      const secrets = opts.secrets ?? []
      // Prompt d'installation ou jeton collé : on signale juste l'activité.
      if (isBrainSetupText(prompt, secrets) || maskOwnSecrets(prompt, secrets).count > 0) return { agent: "claude-code", type: "query", zones: [], session_id }
      // Contenu perso : ni zone, ni empreinte, ni résumé.
      if (looksPersonal(prompt)) return { agent: "claude-code", type: "query", zones: [], session_id }
      const zones = cache?.zones?.length ? classifyZones(prompt, cache.zones, 2) : []
      const event: AgentEventInput = { agent: "claude-code", type: "query", zones, fingerprint: promptFingerprint(prompt), session_id }
      if (opts.shareSummaries !== false && zones.length > 0) event.summary = truncate(redactText(prompt).replace(/\s+/g, " "), 160)
      return event
    }
    default:
      return null
  }
}

async function hookMain(): Promise<void> {
  const raw = await readStdin(800)
  let input: HookInput = {}
  try {
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {}
  } catch {
    return
  }
  const cfg = loadConfig()
  const cache = loadCache()
  // SessionStart : le stdout est injecté dans le contexte de Claude Code → une seule ligne.
  if (input.hook_event_name === "SessionStart" && cfg) process.stdout.write(sessionStartLine(cache) + "\n")
  const event = eventForHook(input, cache, { shareSummaries: cfg?.share_prompt_summaries !== false, secrets: ownSecrets(cfg) })
  if (!cfg || !event) return
  await new BrainApi(cfg.url, cfg.token, HOOK_NETWORK_TIMEOUT_MS).events([event], HOOK_NETWORK_TIMEOUT_MS)
}

function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdout.writableLength === 0) return resolve()
    process.stdout.write("", () => resolve())
  })
}

/** Point d'entrée `brain.mjs hook` : sort toujours avec le code 0. */
export async function runHook(): Promise<never> {
  if (process.env.COMPANY_BRAIN_INTERNAL === "1") process.exit(0)
  const hard = setTimeout(() => process.exit(0), HOOK_GLOBAL_TIMEOUT_MS)
  hard.unref()
  try {
    await hookMain()
  } catch (err) {
    logHookError(err)
  }
  await flushStdout()
  process.exit(0)
}
