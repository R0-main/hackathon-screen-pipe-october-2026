// Un serveur MCP par entreprise, branché directement dans Claude Code et Codex : l'endpoint du cerveau
// (<cerveau>/api/mcp/<entreprise>/<jeton>, HTTP), sous le nom « nos-brainer-<entreprise> ». Chaque agent voit ainsi
// chaque entreprise connectée, avec ses outils, sans processus local. Seul ce qui porte notre préfixe est touché.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { slugify } from "@brain/core"
import { BrainApi } from "./api"
import { claudeDir, codexDir, companiesOf, companyLabel, saveConfig, withCompanies, type Company, type Config } from "./config"
import { findOnPath } from "./distill"
import { runCommand } from "./screenpipe-cli"

type Log = (s: string) => void

export const MCP_PREFIX = "nos-brainer-"

/** Une entreprise dont on connaît l'identifiant (pour construire l'adresse de son serveur MCP). */
export type McpCompany = Company & { id: string }
/** Ce qu'on enregistre pour une entreprise : son nom de serveur et son adresse. */
export type McpServerSpec = { name: string; url: string; label: string }

/** Nom du serveur MCP d'une entreprise : « nos-brainer-fournil » (identifiant en secours, suffixe si deux noms se croisent). */
export function companyMcpName(c: McpCompany, taken: Set<string> = new Set()): string {
  const base = `${MCP_PREFIX}${c.name ? slugify(c.name) : c.id.slice(0, 8)}`
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
  return name
}

/** Adresse du serveur MCP d'une entreprise sur son cerveau : le lien avec l'identifiant de l'entreprise et le jeton. */
export function companyMcpUrl(c: McpCompany): string {
  return `${c.url.replace(/\/+$/, "")}/api/mcp/${encodeURIComponent(c.id)}/${encodeURIComponent(c.token)}`
}

/** Les serveurs à enregistrer, un par entreprise, dans l'ordre du poste. */
export function mcpSpecs(list: McpCompany[]): McpServerSpec[] {
  const taken = new Set<string>()
  return list.map((c) => {
    const name = companyMcpName(c, taken)
    taken.add(name)
    return { name, url: companyMcpUrl(c), label: companyLabel(c) }
  })
}

/** Un de nos serveurs : préfixe « nos-brainer- » et adresse d'un endpoint MCP de cerveau. */
function ours(name: string, url: unknown): boolean {
  return name.startsWith(MCP_PREFIX) && typeof url === "string" && url.includes("/api/mcp/")
}

// --- Claude Code (~/.claude.json, via la CLI `claude`) ---------------------------------------------------------------

/** Où Claude Code range les serveurs MCP de portée utilisateur : ~/.claude.json, ou dans CLAUDE_CONFIG_DIR s'il est défini. */
export function claudeJsonPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(claudeDir(), ".claude.json") : join(homedir(), ".claude.json")
}

/** Nos serveurs MCP enregistrés dans Claude Code (nom → adresse) ; undefined : fichier illisible. */
export function readClaudeMcp(file = claudeJsonPath()): Record<string, string> | undefined {
  if (!existsSync(file)) return {}
  try {
    const servers = (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, { url?: unknown }> })?.mcpServers ?? {}
    return Object.fromEntries(Object.entries(servers).flatMap(([name, s]) => (ours(name, s?.url) ? [[name, s.url as string]] : [])))
  } catch {
    return undefined
  }
}

// --- Codex (~/.codex/config.toml, écrit directement : marche aussi avant la première ouverture de Codex) ---------------

export function codexConfigPath(): string {
  return join(codexDir(), "config.toml")
}

/** Codex est-il là (dossier de config, ou CLI dans le PATH) ? Sinon on ne crée rien chez lui. */
export function codexPresent(): boolean {
  return existsSync(codexDir()) || Boolean(findOnPath("codex"))
}

/** Commentaire posé au-dessus de chacune de nos tables (retiré avec elle). */
const MARK = "# NOS Brainer, entreprise : "

const TABLE_RE = /^\s*\[\s*mcp_servers\.("?)([A-Za-z0-9_-]+)\1(\.[^\]]*)?\s*\]\s*(#.*)?$/

/** Nos serveurs MCP déclarés dans config.toml (nom → adresse). */
export function readCodexMcp(file = codexConfigPath()): Record<string, string> {
  if (!existsSync(file)) return {}
  const out: Record<string, string> = {}
  let current: string | null = null
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.match(TABLE_RE)
    if (t) current = t[3] ? null : t[2]
    else if (/^\s*\[/.test(line)) current = null
    else if (current?.startsWith(MCP_PREFIX)) {
      const u = line.match(/^\s*url\s*=\s*("(?:[^"\\]|\\.)*")\s*(#.*)?$/)
      if (u) {
        try {
          const url = JSON.parse(u[1]) as string
          if (ours(current, url)) out[current] = url
        } catch {
          // valeur illisible : pas la nôtre
        }
      }
    }
  }
  return out
}

/** config.toml sans les tables (et sous-tables) des serveurs `names`. */
function withoutTables(text: string, names: Set<string>): string {
  const keep: string[] = []
  let dropping = false
  for (const line of text.split(/\r?\n/)) {
    const t = line.match(TABLE_RE)
    if (t) dropping = names.has(t[2])
    else if (/^\s*\[/.test(line)) dropping = false
    if (!dropping) keep.push(line)
  }
  return keep.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()
}

/** Écrit config.toml (atomique, mode 600 : il contient les jetons des adresses). */
function writePrivate(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
  if (process.platform !== "win32") chmodSync(file, 0o600)
}

/** Remplace nos serveurs dans config.toml par `specs` (ceux d'entreprises retirées disparaissent). Vrai si le fichier change. */
export function writeCodexMcp(specs: McpServerSpec[], file = codexConfigPath()): boolean {
  const before = existsSync(file) ? readFileSync(file, "utf8") : ""
  const current = readCodexMcp(file)
  if (Object.keys(current).length === specs.length && specs.every((s) => current[s.name] === s.url)) return false
  const names = new Set([...Object.keys(current), ...specs.map((s) => s.name)])
  const blocks = specs.map((s) => `${MARK}${s.label.replace(/[\r\n]/g, " ")}\n[mcp_servers.${s.name}]\nurl = ${JSON.stringify(s.url)}`)
  const rest = withoutTables(before, names)
    .replace(new RegExp(`^${MARK}[^\\n]*$\\n?`, "gm"), "")
    .trimEnd()
  writePrivate(file, `${[rest, ...blocks].filter(Boolean).join("\n\n")}\n`)
  return true
}

// --- Enregistrement (setup), retrait (uninstall), état (doctor) ------------------------------------------------------

/**
 * Les entreprises du poste avec leur identifiant : celui relevé par `init`, sinon demandé au cerveau (et retenu dans la
 * config). null si un cerveau ne le donne pas (version ancienne) ou ne répond pas.
 */
export async function companiesWithIds(cfg: Config): Promise<McpCompany[] | null> {
  const list = companiesOf(cfg)
  let changed = false
  const out: McpCompany[] = []
  for (const c of list) {
    if (c.id) {
      out.push({ ...c, id: c.id })
      continue
    }
    const who = await new BrainApi(c.url, c.token, 8000).whoami().catch(() => null)
    if (!who?.org.id) return null
    Object.assign(c, { id: who.org.id, name: c.name ?? who.org.name, ...(c.description || !who.org.description ? {} : { description: who.org.description }) })
    out.push({ ...c, id: who.org.id })
    changed = true
  }
  if (changed) saveConfig(withCompanies(cfg, list))
  return out
}

/** Le serveur MCP de l'entreprise répond-il (poignée de main MCP) ? Message d'erreur, ou null si oui. */
export async function probeMcp(url: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "brain-setup", version: "1" } } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = (await res.json().catch(() => null)) as { result?: { serverInfo?: unknown }; error?: { message?: string } } | null
    if (res.ok && data?.result?.serverInfo) return null
    return data?.error?.message ?? `réponse ${res.status}`
  } catch (err) {
    return (err as Error).name === "TimeoutError" ? `pas de réponse après ${timeoutMs} ms` : (err as Error).message
  }
}

/** Ce que voit l'agent : l'adresse sans le jeton (les journaux de setup finissent dans la session de Claude Code). */
export function maskedUrl(url: string): string {
  return url.replace(/\/(cb_[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+$/, "/$1…")
}

/**
 * Branche le serveur MCP de chaque entreprise dans Claude Code (`claude mcp add --transport http`) et dans Codex
 * (config.toml), retire ceux d'entreprises qui ne sont plus sur le poste. Vrai si toutes les entreprises sont branchées
 * dans Claude Code (la CLI `claude` absente compte comme un échec : commande à lancer à la main).
 */
export function registerMcpServers(specs: McpServerSpec[], log: Log = console.log): boolean {
  let ok = true
  const claude = findOnPath("claude")
  const current = readClaudeMcp()
  if (!claude) {
    ok = false
    for (const s of specs) log(`MCP ${s.name} : CLI \`claude\` introuvable dans le PATH. À lancer à la main : claude mcp add --transport http --scope user ${s.name} ${s.url}`)
  } else {
    for (const s of specs) {
      if (current?.[s.name] === s.url) {
        log(`MCP ${s.name} (${s.label}) : déjà branché dans Claude Code.`)
        continue
      }
      if (current?.[s.name] || current === undefined) runCommand(claude, ["mcp", "remove", s.name, "--scope", "user"], 30_000)
      const r = runCommand(claude, ["mcp", "add", "--transport", "http", "--scope", "user", s.name, s.url], 30_000)
      if (!r.ok) ok = false
      log(r.ok ? `MCP ${s.name} (${s.label}) branché dans Claude Code : ${maskedUrl(s.url)}.` : `MCP ${s.name} : échec dans Claude Code (${r.stderr.trim().slice(0, 200)}).`)
    }
    // Entreprises qui ne sont plus sur le poste (retirées, ou jeton remplacé : autre adresse sous un autre nom).
    for (const name of Object.keys(current ?? {}).filter((n) => !specs.some((s) => s.name === n))) {
      if (runCommand(claude, ["mcp", "remove", name, "--scope", "user"], 30_000).ok) log(`MCP ${name} retiré de Claude Code (entreprise plus sur ce poste).`)
    }
  }
  if (codexPresent()) {
    try {
      const changed = writeCodexMcp(specs)
      log(`Codex : ${specs.map((s) => s.name).join(", ")} ${changed ? "branché(s)" : "déjà branché(s)"} (${codexConfigPath()}).`)
    } catch (err) {
      log(`Codex : config.toml non modifié (${(err as Error).message}).`)
    }
  }
  return ok
}

/**
 * `companies --default/--remove` : remet les serveurs MCP au niveau des entreprises du poste, seulement si setup les a
 * déjà branchés (sinon c'est le serveur du poste, qui relit la config à chaque appel).
 */
export async function syncCompanyMcp(cfg: Config, log: Log = console.log): Promise<void> {
  if (!Object.keys(readClaudeMcp() ?? {}).length && !Object.keys(readCodexMcp()).length) return
  const list = await companiesWithIds(cfg)
  if (list) registerMcpServers(mcpSpecs(list), log)
  else log("MCP : identifiant d'une entreprise introuvable, serveurs MCP inchangés (relancez setup).")
}

/** Retire tous nos serveurs MCP d'entreprise de Claude Code et de Codex (uninstall). */
export function unregisterMcpServers(log: Log = console.log) {
  const claude = findOnPath("claude")
  for (const name of Object.keys(readClaudeMcp() ?? {})) {
    if (claude && runCommand(claude, ["mcp", "remove", name, "--scope", "user"], 15_000).ok) log(`Serveur MCP ${name} retiré de Claude Code.`)
    else log(`MCP ${name} : à retirer à la main (claude mcp remove ${name} --scope user).`)
  }
  if (existsSync(codexConfigPath()) && Object.keys(readCodexMcp()).length) {
    writeCodexMcp([])
    log(`Serveurs MCP NOS Brainer retirés de Codex (${codexConfigPath()}).`)
  }
}
