// Plusieurs entreprises sur un même poste : on peut appartenir à plusieurs cerveaux (une entreprise créée, une autre
// rejointe…), chacun avec son jeton et son serveur MCP dans Claude Code et Codex (mcp-config.ts). La première est celle
// par défaut : la synchro, les hooks et les skills restent sur elle (et le serveur MCP du poste, en secours, l'interroge
// tant qu'on ne lui en demande pas une autre).

import { normalize, truncate } from "@brain/core"
import { BrainApi } from "./api"
import { refreshCache } from "./cache"
import { companiesOf, companyLabel, requireConfig, saveCache, saveConfig, selfCommand, UserError, withCompanies, type Company } from "./config"
import { syncCompanyMcp } from "./mcp-config"

export { companyLabel }

type Log = (s: string) => void

/** Une ligne par entreprise, numérotées : « 1. Fournil (par défaut) : boulangerie… ». */
export function describeCompanies(list: Company[]): string {
  return list.map((c, i) => `${i + 1}. ${companyLabel(c)}${i === 0 ? " (par défaut)" : ""}${c.description ? ` : ${truncate(c.description.trim(), 200)}` : ""}`).join("\n")
}

/**
 * L'entreprise demandée, par numéro (« 2 »), nom ou début de nom, sans tenir compte des accents ni de la casse ;
 * rien de demandé : la première. Inconnue ou ambiguë : erreur qui liste les entreprises du poste.
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
  throw new UserError(`Entreprise ${partial.length > 1 ? "ambiguë" : "inconnue"} : « ${w} ». Entreprises de ce poste :\n${describeCompanies(list)}`)
}

/**
 * `companies` : liste les entreprises du poste ; `--default <nom|n°>` change celle par défaut ; `--remove <nom|n°>`
 * en retire une (le jeton reste valable sur le cerveau, il n'est plus utilisé ici).
 */
export async function cmdCompanies(flags: Record<string, string | boolean>, log: Log = console.log): Promise<number> {
  const cfg = requireConfig()
  let list = companiesOf(cfg)
  const arg = (k: string) => {
    if (flags[k] === true) throw new UserError(`--${k} : donnez le nom ou le numéro de l'entreprise (voir \`${selfCommand()} companies\`).`)
    return typeof flags[k] === "string" ? (flags[k] as string) : undefined
  }
  const def = arg("default")
  const remove = arg("remove")
  const before = list[0]

  if (remove !== undefined) {
    const c = pickCompany(list, remove)
    if (list.length === 1) throw new UserError(`${companyLabel(c)} est la seule entreprise de ce poste. Pour tout retirer : ${selfCommand()} uninstall`)
    list = list.filter((x) => x !== c)
    log(`${companyLabel(c)} retirée de ce poste.`)
  }
  if (def !== undefined) {
    const c = pickCompany(list, def)
    list = [c, ...list.filter((x) => x !== c)]
  }

  if (list[0] !== before || list.length !== companiesOf(cfg).length) {
    saveConfig(withCompanies(cfg, list))
    if (list[0] !== before) {
      // Le cache (zones, qui je suis) sert aux hooks pour classer les prompts : il suit l'entreprise par défaut.
      const { errors } = await refreshCache(new BrainApi(list[0].url, list[0].token, 8000))
      if (errors.length === 2) saveCache({ updated_at: new Date().toISOString() })
      log(`Entreprise par défaut : ${companyLabel(list[0])}. La synchro, les hooks et les skills passent sur elle.`)
    }
    // Serveurs MCP de Claude Code et Codex : ceux des entreprises restantes (une entreprise retirée perd le sien).
    await syncCompanyMcp(requireConfig(), log)
  }

  log(list.length > 1 ? "Entreprises de ce poste (les agents passent `company` pour en viser une autre que la première) :" : "Entreprise de ce poste :")
  log(describeCompanies(list))
  if (list.length > 1 && def === undefined && remove === undefined) {
    log(`Changer celle par défaut : ${selfCommand()} companies --default <nom ou n°> — en retirer une : ${selfCommand()} companies --remove <nom ou n°>`)
  }
  return 0
}
