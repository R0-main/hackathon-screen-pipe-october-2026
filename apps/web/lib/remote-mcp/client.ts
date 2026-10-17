// Client MCP minimal en Streamable HTTP : ouvre une session (initialize), liste les outils ou en appelle un, referme
// la session. Réponses en JSON ou en SSE ; l'identifiant de session (Mcp-Session-Id) est renvoyé à chaque appel.

import { findResponse, isReadOnlyTool, type JsonRpcMessage, type McpToolDef } from "@brain/core"
import { guardedRequest, type NetDeps } from "./net"
import { CLIENT_NAME } from "./oauth"
import { DEFAULT_DEPS } from "../scrape"

const PROTOCOL_VERSION = "2025-06-18"
const MAX_TOOL_PAGES = 5
/** Un appel d'outil peut être long (recherche, export) ; la liste des outils, non. */
const CALL_TIMEOUT_MS = 45_000
const CALL_MAX_BYTES = 4_000_000
/** Schéma d'entrée gardé par outil (au-delà : schéma vide, l'agent lit la description). */
const MAX_SCHEMA_CHARS = 20_000

/** 401/403 du serveur MCP : jeton absent, expiré ou révoqué. */
export class McpAuthError extends Error {
  constructor(status: number) {
    super(`accès refusé par le serveur MCP (HTTP ${status})`)
  }
}

type Session = { call: (method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number; maxBytes?: number }) => Promise<JsonRpcMessage>; server?: string; close: () => void }

/** Ouvre une session MCP (initialize + notifications/initialized). */
async function openSession(serverUrl: string, bearer: string | undefined, deps: NetDeps): Promise<Session> {
  let sessionId: string | undefined
  let protocol = PROTOCOL_VERSION
  let nextId = 1

  async function send(method: string, params: Record<string, unknown> | undefined, notification: boolean, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<JsonRpcMessage | null> {
    const id = nextId++
    const res = await guardedRequest(
      serverUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": protocol,
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(notification ? { jsonrpc: "2.0", method, ...(params ? { params } : {}) } : { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
        // Un flux SSE peut rester ouvert après la réponse : on s'arrête dès qu'elle est là.
        until: notification ? undefined : (body) => findResponse(body, "text/event-stream", id) !== null,
        timeoutMs: opts.timeoutMs,
        maxBytes: opts.maxBytes,
      },
      deps,
    )
    if (res.status === 401 || res.status === 403) throw new McpAuthError(res.status)
    if (notification) return null
    if (res.status < 200 || res.status >= 300) throw new Error(`le serveur MCP répond HTTP ${res.status}${res.status === 404 ? " (adresse du serveur incorrecte ?)" : ""}`)
    sessionId = res.headers["mcp-session-id"] ?? sessionId
    const msg = findResponse(res.body, res.headers["content-type"] ?? "", id)
    if (!msg) throw new Error(res.truncated ? `réponse MCP trop volumineuse à « ${method} »` : `réponse MCP illisible à « ${method} »`)
    if (msg.error) throw new Error(`erreur MCP à « ${method} » : ${msg.error.message}`)
    return msg
  }

  const init = await send("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: CLIENT_NAME, version: "0.1" } }, false)
  const initResult = (init?.result ?? {}) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } }
  if (typeof initResult.protocolVersion === "string") protocol = initResult.protocolVersion
  await send("notifications/initialized", undefined, true).catch(() => null)
  const info = initResult.serverInfo
  return {
    server: info?.name ? `${info.name}${info.version ? ` ${info.version}` : ""}` : undefined,
    call: async (method, params, opts) => (await send(method, params ?? {}, false, opts))!,
    close: () => {
      // Fin de session, sans attendre ni échouer.
      if (sessionId)
        void guardedRequest(serverUrl, { method: "DELETE", headers: { "mcp-session-id": sessionId, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, timeoutMs: 5_000 }, deps).catch(() => null)
    },
  }
}

async function withSession<T>(serverUrl: string, bearer: string | undefined, deps: NetDeps, fn: (s: Session) => Promise<T>): Promise<T> {
  const session = await openSession(serverUrl, bearer, deps)
  try {
    return await fn(session)
  } finally {
    session.close()
  }
}

function toDef(t: { name?: unknown; title?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown; title?: unknown } | null }): McpToolDef | null {
  if (typeof t.name !== "string" || !t.name) return null
  const schema = t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Record<string, unknown>) : {}
  const input_schema = JSON.stringify(schema).length <= MAX_SCHEMA_CHARS ? schema : { type: "object" }
  const title = typeof t.title === "string" ? t.title : typeof t.annotations?.title === "string" ? t.annotations.title : undefined
  return {
    name: t.name,
    title,
    description: typeof t.description === "string" ? t.description.slice(0, 2000) : undefined,
    input_schema: input_schema.type === "object" ? input_schema : { ...input_schema, type: "object" },
    read_only: isReadOnlyTool({ name: t.name, annotations: t.annotations }),
  }
}

export type ToolsResult = { server?: string; tools: McpToolDef[] }

/** Outils du serveur (toutes les pages, bornées), avec leur schéma et leur caractère lecture seule. */
export async function listTools(serverUrl: string, bearer: string | undefined, deps: NetDeps = DEFAULT_DEPS): Promise<ToolsResult> {
  return withSession(serverUrl, bearer, deps, async (s) => {
    const tools: McpToolDef[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const msg = await s.call("tools/list", cursor ? { cursor } : {})
      const r = (msg.result ?? {}) as { tools?: Parameters<typeof toDef>[0][]; nextCursor?: unknown }
      for (const t of r.tools ?? []) {
        const def = toDef(t)
        if (def) tools.push(def)
      }
      cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined
      if (!cursor) break
    }
    return { server: s.server, tools }
  })
}

/** Appelle l'outil `name` ; renvoie le résultat MCP brut (`content`, `isError`, `structuredContent`). */
export async function callTool(serverUrl: string, bearer: string | undefined, name: string, args: Record<string, unknown>, deps: NetDeps = DEFAULT_DEPS): Promise<unknown> {
  return withSession(serverUrl, bearer, deps, async (s) => (await s.call("tools/call", { name, arguments: args }, { timeoutMs: CALL_TIMEOUT_MS, maxBytes: CALL_MAX_BYTES })).result)
}
