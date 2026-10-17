// Serveur MCP stdio « company-brain » : les agents de l'employé lisent (et enrichissent) le cerveau.
// Rien ne doit être écrit sur stdout en dehors du transport : les journaux vont sur stderr.
// Poste branché sur plusieurs entreprises : chaque outil prend `company` (par défaut la première) ; le nom et la
// description de chacune, dans les instructions du serveur et la description du paramètre, guident le choix du modèle.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { redactText } from "@brain/core"
import { createBrainMcpServer as createServer } from "@brain/core/mcp"
import { BrainApi } from "./api"
import { companyLabel, describeCompanies, pickCompany } from "./companies"
import { companiesOf, loadCache, loadConfig, selfCommand, type Company } from "./config"
import { maskOwnSecrets, ownSecrets } from "./secrets"

/** Consigne du serveur quand le poste a plusieurs entreprises : laquelle interroger, et quand en changer. */
export function companiesInstructions(list: Company[]): string {
  return (
    `Ce poste est branché sur ${list.length} entreprises, chacune avec son propre cerveau. Les outils interrogent la première par défaut ; ` +
    "passez `company` (nom ou numéro) seulement quand la demande porte sur une autre entreprise, d'après son nom ou sa description. " +
    "Chaque réponse commence par l'entreprise qui a répondu.\n" +
    describeCompanies(list)
  )
}

export function createBrainMcpServer(version = "0.1.0"): McpServer {
  // Les entreprises connues au démarrage décrivent les outils ; chaque appel relit la config (entreprise ajoutée entre-temps).
  const startCfg = loadConfig()
  const known = startCfg ? companiesOf(startCfg) : []
  const multi = known.length > 1
  return createServer({
    version,
    instructions: multi ? companiesInstructions(known) : undefined,
    companyParam: multi
      ? `Entreprise à interroger, par nom ou numéro ; par défaut la première (« ${companyLabel(known[0])} »). À préciser seulement quand ` +
        `la demande porte sur une autre entreprise du poste :\n${describeCompanies(known)}`
      : undefined,
    open: (wanted) => {
      const cfg = loadConfig()
      if (!cfg) throw new Error(`Client du cerveau non configuré : lancez \`${selfCommand()} init --url <url> --token <jeton>\`.`)
      const list = companiesOf(cfg)
      const company = pickCompany(list, wanted)
      return {
        api: new BrainApi(company.url, company.token, 20000),
        key: company.token,
        // Plusieurs entreprises : chaque réponse dit laquelle a répondu.
        header: list.length > 1 ? `Entreprise : ${companyLabel(company)}\n\n` : "",
        // Le cache du poste (zones, droits) est celui de la première entreprise.
        cache: () => (company.token === cfg.token ? loadCache() : null),
      }
    },
    // Secrets du poste (jetons du cerveau, jetons Screenpipe / Claude Code, clé API) masqués tels quels.
    clean: (t) => {
      const secrets = ownSecrets(loadConfig())
      return maskOwnSecrets(redactText(t, { literals: secrets }), secrets).text
    },
  })
}

export async function runMcpServer(version?: string) {
  // Garde-fou : tout console.log accidentel part sur stderr pour ne pas corrompre le protocole.
  console.log = (...args: unknown[]) => console.error(...args)
  const server = createBrainMcpServer(version)
  await server.connect(new StdioServerTransport())
  console.error("[company-brain] serveur MCP prêt (stdio)")
}
