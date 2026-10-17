// One MCP server per company, plugged directly into Claude Code and Codex: the brain's endpoint
// (<brain>/api/mcp/<company>/<token>, HTTP), under the name "nos-brainer-<company>". Each agent thus sees each connected
// company, with its tools, without a local process. Only what carries our prefix is touched.

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

/** A company whose id is known (to build the address of its MCP server). */
export type McpCompany = Company & { id: string }
/** What is registered for a company: its server name and its address. */
export type McpServerSpec = { name: string; url: string; label: string }

/** A company's MCP server name: "nos-brainer-fournil" (id as a fallback, suffix if two names collide). */
export function companyMcpName(c: McpCompany, taken: Set<string> = new Set()): string {
  const base = `${MCP_PREFIX}${c.name ? slugify(c.name) : c.id.slice(0, 8)}`
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
  return name
}

/** Address of a company's MCP server on its brain: the link with the company id and the token. */
export function companyMcpUrl(c: McpCompany): string {
  return `${c.url.replace(/\/+$/, "")}/api/mcp/${encodeURIComponent(c.id)}/${encodeURIComponent(c.token)}`
}

/** The servers to register, one per company, in the computer's order. */
export function mcpSpecs(list: McpCompany[]): McpServerSpec[] {
  const taken = new Set<string>()
  return list.map((c) => {
    const name = companyMcpName(c, taken)
    taken.add(name)
    return { name, url: companyMcpUrl(c), label: companyLabel(c) }
  })
}

/** One of our servers: "nos-brainer-" prefix and the address of a brain MCP endpoint. */
function ours(name: string, url: unknown): boolean {
  return name.startsWith(MCP_PREFIX) && typeof url === "string" && url.includes("/api/mcp/")
}

// --- Claude Code (~/.claude.json, through the `claude` CLI) ----------------------------------------------------------

/** Where Claude Code stores user-scope MCP servers: ~/.claude.json, or in CLAUDE_CONFIG_DIR if it is set. */
export function claudeJsonPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(claudeDir(), ".claude.json") : join(homedir(), ".claude.json")
}

/** Our MCP servers registered in Claude Code (name → address); undefined: unreadable file. */
export function readClaudeMcp(file = claudeJsonPath()): Record<string, string> | undefined {
  if (!existsSync(file)) return {}
  try {
    const servers = (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, { url?: unknown }> })?.mcpServers ?? {}
    return Object.fromEntries(Object.entries(servers).flatMap(([name, s]) => (ours(name, s?.url) ? [[name, s.url as string]] : [])))
  } catch {
    return undefined
  }
}

/**
 * Writes user-scope servers straight into ~/.claude.json (null removes one), the rest of the file kept: for Claude Code
 * of the desktop app alone, whose copy of the CLI is not in the PATH but which reads the same file. Throws if the file
 * is unreadable (never overwritten then).
 */
export function editClaudeMcp(entries: Record<string, Record<string, unknown> | null>, file = claudeJsonPath()): void {
  const data: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file}: not a JSON object`)
  const servers = { ...((data as { mcpServers?: Record<string, unknown> }).mcpServers ?? {}) }
  for (const [name, entry] of Object.entries(entries)) {
    if (entry) servers[name] = entry
    else delete servers[name]
  }
  writePrivate(file, `${JSON.stringify({ ...data, mcpServers: servers }, null, 2)}\n`)
}

/** Removes a user-scope server from Claude Code: through the `claude` CLI if there is one, otherwise from ~/.claude.json. */
export function removeClaudeMcp(claude: string | null, name: string, timeoutMs = 30_000): boolean {
  if (claude) return runCommand(claude, ["mcp", "remove", name, "--scope", "user"], timeoutMs).ok
  try {
    editClaudeMcp({ [name]: null })
    return true
  } catch {
    return false
  }
}

// --- Codex (~/.codex/config.toml, written directly: also works before Codex is first opened) --------------------------

export function codexConfigPath(): string {
  return join(codexDir(), "config.toml")
}

/** Is Codex there (config folder, or CLI in the PATH)? Otherwise nothing is created for it. */
export function codexPresent(): boolean {
  return existsSync(codexDir()) || Boolean(findOnPath("codex"))
}

/** Comment placed above each of our tables (removed with it). */
const MARK = "# NOS Brainer, company: "
/** The same comment as written by earlier (French) versions: removed too. */
const LEGACY_MARK = "# NOS Brainer, entreprise : "

const TABLE_RE = /^\s*\[\s*mcp_servers\.("?)([A-Za-z0-9_-]+)\1(\.[^\]]*)?\s*\]\s*(#.*)?$/

/** Our MCP servers declared in config.toml (name → address). */
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
          // unreadable value: not ours
        }
      }
    }
  }
  return out
}

/** config.toml without the tables (and subtables) of the `names` servers. */
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

/** Writes config.toml (atomic, mode 600: it contains the tokens in the addresses). */
function writePrivate(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
  if (process.platform !== "win32") chmodSync(file, 0o600)
}

/** Replaces our servers in config.toml with `specs` (those of removed companies disappear). True if the file changes. */
export function writeCodexMcp(specs: McpServerSpec[], file = codexConfigPath()): boolean {
  const before = existsSync(file) ? readFileSync(file, "utf8") : ""
  const current = readCodexMcp(file)
  if (Object.keys(current).length === specs.length && specs.every((s) => current[s.name] === s.url)) return false
  const names = new Set([...Object.keys(current), ...specs.map((s) => s.name)])
  const blocks = specs.map((s) => `${MARK}${s.label.replace(/[\r\n]/g, " ")}\n[mcp_servers.${s.name}]\nurl = ${JSON.stringify(s.url)}`)
  const rest = withoutTables(before, names)
    .replace(new RegExp(`^(?:${MARK}|${LEGACY_MARK})[^\\n]*$\\n?`, "gm"), "")
    .trimEnd()
  writePrivate(file, `${[rest, ...blocks].filter(Boolean).join("\n\n")}\n`)
  return true
}

// --- Registration (setup), removal (uninstall), state (doctor) -------------------------------------------------------

/**
 * The computer's companies with their id: the one noted by `init`, otherwise asked from the brain (and kept in the
 * config). null if a brain does not give it (old version) or does not answer.
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

/** Does the company's MCP server answer (MCP handshake)? Error message, or null if it does. */
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
    return data?.error?.message ?? `response ${res.status}`
  } catch (err) {
    return (err as Error).name === "TimeoutError" ? `no response after ${timeoutMs} ms` : (err as Error).message
  }
}

/** What the agent sees: the address without the token (setup logs end up in the Claude Code session). */
export function maskedUrl(url: string): string {
  return url.replace(/\/(cb_[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+$/, "/$1…")
}

/**
 * Plugs each company's MCP server into Claude Code (`claude mcp add --transport http`; without the CLI in the PATH,
 * Claude Code of the desktop app alone: written into ~/.claude.json) and into Codex (config.toml), removes those of
 * companies no longer on the computer. True if all companies are plugged into Claude Code.
 */
export function registerMcpServers(specs: McpServerSpec[], log: Log = console.log): boolean {
  let ok = true
  const claude = findOnPath("claude")
  const current = readClaudeMcp()
  if (!claude) {
    const stale = Object.keys(current ?? {}).filter((n) => !specs.some((s) => s.name === n))
    try {
      if (stale.length || specs.some((s) => current?.[s.name] !== s.url)) {
        editClaudeMcp({ ...Object.fromEntries(stale.map((n) => [n, null])), ...Object.fromEntries(specs.map((s) => [s.name, { type: "http", url: s.url }])) })
      }
      for (const s of specs) {
        log(current?.[s.name] === s.url ? `MCP ${s.name} (${s.label}): already plugged into Claude Code.` : `MCP ${s.name} (${s.label}) plugged into Claude Code (${claudeJsonPath()}, no \`claude\` CLI in the PATH): ${maskedUrl(s.url)}.`)
      }
      for (const n of stale) log(`MCP ${n} removed from Claude Code (company no longer on this computer).`)
    } catch (err) {
      ok = false
      log(`MCP: ${claudeJsonPath()} not changed (${(err as Error).message}): fix or delete it, then run setup again.`)
    }
  } else {
    for (const s of specs) {
      if (current?.[s.name] === s.url) {
        log(`MCP ${s.name} (${s.label}): already plugged into Claude Code.`)
        continue
      }
      if (current?.[s.name] || current === undefined) runCommand(claude, ["mcp", "remove", s.name, "--scope", "user"], 30_000)
      const r = runCommand(claude, ["mcp", "add", "--transport", "http", "--scope", "user", s.name, s.url], 30_000)
      if (!r.ok) ok = false
      log(r.ok ? `MCP ${s.name} (${s.label}) plugged into Claude Code: ${maskedUrl(s.url)}.` : `MCP ${s.name}: failed in Claude Code (${r.stderr.trim().slice(0, 200)}).`)
    }
    // Companies no longer on the computer (removed, or token replaced: another address under another name).
    for (const name of Object.keys(current ?? {}).filter((n) => !specs.some((s) => s.name === n))) {
      if (runCommand(claude, ["mcp", "remove", name, "--scope", "user"], 30_000).ok) log(`MCP ${name} removed from Claude Code (company no longer on this computer).`)
    }
  }
  if (codexPresent()) {
    try {
      const changed = writeCodexMcp(specs)
      log(`Codex: ${specs.map((s) => s.name).join(", ")} ${changed ? "plugged in" : "already plugged in"} (${codexConfigPath()}).`)
    } catch (err) {
      log(`Codex: config.toml not changed (${(err as Error).message}).`)
    }
  }
  return ok
}

/**
 * `companies --default/--remove`: brings the MCP servers in line with the computer's companies, only if setup already
 * plugged them in (otherwise it is the computer's server, which rereads the config on each call).
 */
export async function syncCompanyMcp(cfg: Config, log: Log = console.log): Promise<void> {
  if (!Object.keys(readClaudeMcp() ?? {}).length && !Object.keys(readCodexMcp()).length) return
  const list = await companiesWithIds(cfg)
  if (list) registerMcpServers(mcpSpecs(list), log)
  else log("MCP: a company's id was not found, MCP servers unchanged (rerun setup).")
}

/** Removes all our company MCP servers from Claude Code and Codex (uninstall). */
export function unregisterMcpServers(log: Log = console.log) {
  const claude = findOnPath("claude")
  for (const name of Object.keys(readClaudeMcp() ?? {})) {
    if (removeClaudeMcp(claude, name, 15_000)) log(`MCP server ${name} removed from Claude Code.`)
    else log(`MCP ${name}: to remove by hand (claude mcp remove ${name} --scope user).`)
  }
  if (existsSync(codexConfigPath()) && Object.keys(readCodexMcp()).length) {
    writeCodexMcp([])
    log(`NOS Brainer MCP servers removed from Codex (${codexConfigPath()}).`)
  }
}
