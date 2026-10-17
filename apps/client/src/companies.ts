// Several companies on one computer: you can belong to several brains (one company created, another joined…), each
// with its token and its MCP server in Claude Code and Codex (mcp-config.ts). The first one is the default: sync, hooks
// and skills stay on it (and the computer's MCP server, as a fallback, queries it unless asked for another one).

import { normalize, truncate } from "@brain/core"
import { BrainApi } from "./api"
import { refreshCache } from "./cache"
import { companiesOf, companyLabel, requireConfig, saveCache, saveConfig, selfCommand, UserError, withCompanies, type Company } from "./config"
import { syncCompanyMcp } from "./mcp-config"

export { companyLabel }

type Log = (s: string) => void

/** One numbered line per company: "1. Butine (default): connected scales for beehives…". */
export function describeCompanies(list: Company[]): string {
  return list.map((c, i) => `${i + 1}. ${companyLabel(c)}${i === 0 ? " (default)" : ""}${c.description ? `: ${truncate(c.description.trim(), 200)}` : ""}`).join("\n")
}

/**
 * The requested company, by number ("2"), name or start of name, ignoring accents and case; nothing requested: the
 * first one. Unknown or ambiguous: an error that lists the computer's companies.
 */
export function pickCompany(list: Company[], wanted?: string): Company {
  const w = wanted?.trim()
  if (!w) return list[0]
  if (/^\d+$/.test(w) && list[Number(w) - 1]) return list[Number(w) - 1]
  const n = normalize(w)
  const exact = list.find((c) => c.id === w || (c.name && normalize(c.name) === n) || c.url === w)
  if (exact) return exact
  const partial = list.filter((c) => c.name && normalize(c.name).includes(n))
  if (partial.length === 1) return partial[0]
  throw new UserError(`${partial.length > 1 ? "Ambiguous" : "Unknown"} company: "${w}". Companies on this computer:\n${describeCompanies(list)}`)
}

/**
 * `companies`: lists the computer's companies; `--default <name|no.>` changes the default one; `--remove <name|no.>`
 * removes one (the token stays valid on the brain, it is no longer used here).
 */
export async function cmdCompanies(flags: Record<string, string | boolean>, log: Log = console.log): Promise<number> {
  const cfg = requireConfig()
  let list = companiesOf(cfg)
  const arg = (k: string) => {
    if (flags[k] === true) throw new UserError(`--${k}: give the company's name or number (see \`${selfCommand()} companies\`).`)
    return typeof flags[k] === "string" ? (flags[k] as string) : undefined
  }
  const def = arg("default")
  const remove = arg("remove")
  const before = list[0]

  if (remove !== undefined) {
    const c = pickCompany(list, remove)
    if (list.length === 1) throw new UserError(`${companyLabel(c)} is the only company on this computer. To remove everything: ${selfCommand()} uninstall`)
    list = list.filter((x) => x !== c)
    log(`${companyLabel(c)} removed from this computer.`)
  }
  if (def !== undefined) {
    const c = pickCompany(list, def)
    list = [c, ...list.filter((x) => x !== c)]
  }

  if (list[0] !== before || list.length !== companiesOf(cfg).length) {
    saveConfig(withCompanies(cfg, list))
    if (list[0] !== before) {
      // The cache (zones, who I am) is used by the hooks to classify prompts: it follows the default company.
      const { errors } = await refreshCache(new BrainApi(list[0].url, list[0].token, 8000))
      if (errors.length === 2) saveCache({ updated_at: new Date().toISOString() })
      log(`Default company: ${companyLabel(list[0])}. Sync, hooks and skills move to it.`)
    }
    // Claude Code and Codex MCP servers: those of the remaining companies (a removed company loses its own).
    await syncCompanyMcp(requireConfig(), log)
  }

  log(list.length > 1 ? "Companies on this computer (agents pass `company` to target one other than the first):" : "Company on this computer:")
  log(describeCompanies(list))
  if (list.length > 1 && def === undefined && remove === undefined) {
    log(`Change the default one: ${selfCommand()} companies --default <name or no.> — remove one: ${selfCommand()} companies --remove <name or no.>`)
  }
  return 0
}
