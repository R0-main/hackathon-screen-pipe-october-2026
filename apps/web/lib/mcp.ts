// The brain's MCP endpoint: one MCP server per company, at /api/mcp/<company>/<token> ("streamable" HTTP, stateless,
// JSON responses). Claude Code and Codex plug into it directly (`brain setup` registers it under the company's name):
// same tools as the computer's MCP server (@brain/core/mcp), with the token's rights.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { Org, Profile } from "@brain/core"
import { createBrainMcpServer, type ApiZone, type BrainToolsApi } from "@brain/core/mcp"
import * as connectedToolsRoute from "@/app/api/connected-tools/route"
import * as connectedCallRoute from "@/app/api/connected-tools/call/route"
import * as ingestRoute from "@/app/api/ingest/route"
import * as queryRoute from "@/app/api/query/route"
import * as statusRoute from "@/app/api/status/route"
import * as whoamiRoute from "@/app/api/whoami/route"
import * as zoneRoute from "@/app/api/zones/[id]/route"
import * as zonesRoute from "@/app/api/zones/route"
import { profileFromToken } from "./auth"
import { publicBaseUrl } from "./http"
import { possessive } from "./install-prompt"
import { registerBrainApps } from "./mcp-apps"
import { recordIncident } from "./monitoring"
import { storeForOrg } from "./store"

type Route = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

/**
 * The tools call the API routes in place, as the computer would with its token: same per-zone rights, same redaction,
 * same events (the queried zone lights up), without a network round trip.
 */
function routesApi(token: string): BrainToolsApi {
  const call = async <T>(route: Route, method: "GET" | "POST", path: string, body?: unknown, params: Record<string, string> = {}): Promise<T> => {
    const req = new Request(`http://brain.local${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const res = await route(req, { params: Promise.resolve(params) })
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    if (!res.ok) throw new Error(`The brain answered ${res.status}${data?.error ? `: ${data.error}` : ""}`)
    return data as T
  }
  return {
    whoami: () => call(whoamiRoute.GET as Route, "GET", "/api/whoami"),
    zones: () => call<{ zones: ApiZone[] }>(zonesRoute.GET as Route, "GET", "/api/zones").then((r) => r.zones),
    zone: (id) => call(zoneRoute.GET as Route, "GET", `/api/zones/${encodeURIComponent(id)}`, undefined, { id }),
    status: () => call(statusRoute.GET as Route, "GET", "/api/status"),
    query: (input) => call(queryRoute.POST as Route, "POST", "/api/query", input),
    ingest: (items, agent = "mcp") => call(ingestRoute.POST as Route, "POST", "/api/ingest", { items, agent }),
    connectedTools: ({ connector, query }) => {
      const q = new URLSearchParams({ ...(connector ? { connector } : {}), ...(query ? { query } : {}) })
      return call(connectedToolsRoute.GET as Route, "GET", `/api/connected-tools${q.toString() ? `?${q}` : ""}`)
    },
    callConnectedTool: (input) => call(connectedCallRoute.POST as Route, "POST", "/api/connected-tools/call", input),
  }
}

/** The server's instruction: which company it is (its name and description guide the model), for whom. */
export function mcpInstructions(org: Pick<Org, "name" | "description">, profile: Pick<Profile, "name">): string {
  return (
    `${possessive(org.name)} company brain${org.description?.trim() ? `: ${org.description.trim().replace(/[.\s]+$/, "")}` : ""}. ` +
    `Connected on behalf of ${profile.name}, with their per-zone rights. Query it (search_brain) before guessing whenever a ` +
    `question touches ${possessive(org.name)} context (decisions, procedures, customers, projects, tools); remember saves knowledge in it.`
  )
}

function rpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status, headers })
}

/** An MCP request for the `orgId` company, with the personal token of one of its members. */
export async function handleMcp(req: Request, orgId: string, token: string | null | undefined): Promise<Response> {
  // Stateless: no SSE stream opened by GET, no session to close by DELETE.
  if (req.method !== "POST") return rpcError(405, "Stateless MCP server: POST requests only.", { allow: "POST" })
  try {
    const profile = token ? await profileFromToken(token) : null
    if (!token || !profile || profile.org_id !== orgId) return rpcError(401, "Invalid token for this company: rerun `brain setup` with a valid token.")
    const org = await storeForOrg(orgId).getOrg()
    const server = createBrainMcpServer({
      instructions: mcpInstructions(org, profile),
      open: () => ({ api: routesApi(token), key: orgId }),
      sourceApp: "mcp",
    })
    // The views (brain, automations, team), for clients that render MCP Apps.
    registerBrainApps(server, { token, baseUrl: publicBaseUrl(req), org: org.name })
    // A new transport per request (stateless mode): nothing is shared between two clients.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return await transport.handleRequest(req)
  } catch (err) {
    console.error("[mcp]", err)
    recordIncident("/api/mcp", err)
    return rpcError(500, "Internal brain error.")
  }
}
