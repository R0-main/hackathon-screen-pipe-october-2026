// Client MCP minimal en Streamable HTTP : ouvre une session (initialize), liste les outils, referme la session.
// Réponses en JSON ou en SSE ; l'identifiant de session (Mcp-Session-Id) est renvoyé à chaque appel.

import { findResponse, type JsonRpcMessage } from "@brain/core"
import { guardedRequest, type NetDeps } from "./net"
import { CLIENT_NAME } from "./oauth"
import { DEFAULT_DEPS } from "../scrape"

const PROTOCOL_VERSION = "2025-06-18"
const MAX_TOOL_PAGES = 5

/** 401/403 du serveur MCP : jeton absent, expiré ou révoqué. */
export class McpAuthError extends Error {
  constructor(status: number) {
    super(`accès refusé par le serveur MCP (HTTP ${status})`)
  }
}

export type ToolsResult = { server?: string; tools: string[] }

export async function listTools(serverUrl: string, bearer: string | undefined, deps: NetDeps = DEFAULT_DEPS): Promise<ToolsResult> {
  let sessionId: string | undefined
  let protocol = PROTOCOL_VERSION
  let nextId = 1

  async function call(method: string, params: Record<string, unknown> | undefined, notification = false): Promise<JsonRpcMessage | null> {
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
      },
      deps,
    )
    if (res.status === 401 || res.status === 403) throw new McpAuthError(res.status)
    if (notification) return null
    if (res.status < 200 || res.status >= 300) throw new Error(`le serveur MCP répond HTTP ${res.status}${res.status === 404 ? " (adresse du serveur incorrecte ?)" : ""}`)
    sessionId = res.headers["mcp-session-id"] ?? sessionId
    const msg = findResponse(res.body, res.headers["content-type"] ?? "", id)
    if (!msg) throw new Error(`réponse MCP illisible à « ${method} »`)
    if (msg.error) throw new Error(`erreur MCP à « ${method} » : ${msg.error.message}`)
    return msg
  }

  const init = await call("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: CLIENT_NAME, version: "0.1" } })
  const initResult = (init?.result ?? {}) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } }
  if (typeof initResult.protocolVersion === "string") protocol = initResult.protocolVersion
  await call("notifications/initialized", undefined, true).catch(() => null)

  const tools: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const msg = await call("tools/list", cursor ? { cursor } : {})
    const r = (msg?.result ?? {}) as { tools?: { name?: unknown }[]; nextCursor?: unknown }
    for (const t of r.tools ?? []) if (typeof t.name === "string") tools.push(t.name)
    cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined
    if (!cursor) break
  }

  if (sessionId) {
    // Fin de session, sans attendre ni échouer.
    void guardedRequest(serverUrl, { method: "DELETE", headers: { "mcp-session-id": sessionId, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, timeoutMs: 5_000 }, deps).catch(() => null)
  }
  const info = initResult.serverInfo
  return { server: info?.name ? `${info.name}${info.version ? ` ${info.version}` : ""}` : undefined, tools }
}
