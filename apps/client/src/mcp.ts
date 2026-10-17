// "company-brain" stdio MCP server: the employee's agents read (and enrich) the brain.
// Nothing must be written to stdout outside the transport: logs go to stderr.
// Computer connected to several companies: each tool takes `company` (the first one by default); the name and
// description of each one, in the server's instructions and the parameter's description, guide the model's choice.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { redactText } from "@brain/core"
import { createBrainMcpServer as createServer } from "@brain/core/mcp"
import { BrainApi } from "./api"
import { companyLabel, describeCompanies, pickCompany } from "./companies"
import { companiesOf, loadCache, loadConfig, selfCommand, type Company } from "./config"
import { maskOwnSecrets, ownSecrets } from "./secrets"

/** The server's instruction when the computer has several companies: which one to query, and when to switch. */
export function companiesInstructions(list: Company[]): string {
  return (
    `This computer is connected to ${list.length} companies, each with its own brain. The tools query the first one by default; ` +
    "pass `company` (name or number) only when the request is about another company, going by its name or description. " +
    "Each answer starts with the company that answered.\n" +
    describeCompanies(list)
  )
}

export function createBrainMcpServer(version = "0.1.0"): McpServer {
  // The companies known at start describe the tools; each call reads the config again (company added in the meantime).
  const startCfg = loadConfig()
  const known = startCfg ? companiesOf(startCfg) : []
  const multi = known.length > 1
  return createServer({
    version,
    instructions: multi ? companiesInstructions(known) : undefined,
    companyParam: multi
      ? `Company to query, by name or number; the first one by default ("${companyLabel(known[0])}"). Only give it when ` +
        `the request is about another company of the computer:\n${describeCompanies(known)}`
      : undefined,
    open: (wanted) => {
      const cfg = loadConfig()
      if (!cfg) throw new Error(`Brain client not configured: run \`${selfCommand()} init --url <url> --token <token>\`.`)
      const list = companiesOf(cfg)
      const company = pickCompany(list, wanted)
      return {
        api: new BrainApi(company.url, company.token, 20000),
        key: company.token,
        // Several companies: each answer says which one answered.
        header: list.length > 1 ? `Company: ${companyLabel(company)}\n\n` : "",
        // The computer's cache (zones, access) is the first company's.
        cache: () => (company.token === cfg.token ? loadCache() : null),
      }
    },
    // The computer's secrets (brain tokens, Screenpipe / Claude Code tokens, API key) redacted as is.
    clean: (t) => {
      const secrets = ownSecrets(loadConfig())
      return maskOwnSecrets(redactText(t, { literals: secrets }), secrets).text
    },
  })
}

export async function runMcpServer(version?: string) {
  // Safeguard: any accidental console.log goes to stderr so as not to corrupt the protocol.
  console.log = (...args: unknown[]) => console.error(...args)
  const server = createBrainMcpServer(version)
  await server.connect(new StdioServerTransport())
  console.error("[company-brain] MCP server ready (stdio)")
}
