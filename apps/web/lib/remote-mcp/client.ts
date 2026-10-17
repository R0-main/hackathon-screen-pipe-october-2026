// Minimal MCP client over Streamable HTTP: opens a session (initialize), lists the tools, closes the session.
// Responses in JSON or SSE; the session id (Mcp-Session-Id) is sent back on each call.

import { findResponse, type JsonRpcMessage } from "@brain/core"
import { guardedRequest, type NetDeps } from "./net"
import { CLIENT_NAME } from "./oauth"
import { DEFAULT_DEPS } from "../scrape"

const PROTOCOL_VERSION = "2025-06-18"
const MAX_TOOL_PAGES = 5

/** 401/403 from the MCP server: token missing, expired or revoked. */
export class McpAuthError extends Error {
  constructor(status: number) {
    super(`access refused by the MCP server (HTTP ${status})`)
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
        // An SSE stream can stay open after the response: stop as soon as it is there.
        until: notification ? undefined : (body) => findResponse(body, "text/event-stream", id) !== null,
      },
      deps,
    )
    if (res.status === 401 || res.status === 403) throw new McpAuthError(res.status)
    if (notification) return null
    if (res.status < 200 || res.status >= 300) throw new Error(`the MCP server answers HTTP ${res.status}${res.status === 404 ? " (wrong server address?)" : ""}`)
    sessionId = res.headers["mcp-session-id"] ?? sessionId
    const msg = findResponse(res.body, res.headers["content-type"] ?? "", id)
    if (!msg) throw new Error(`unreadable MCP response to "${method}"`)
    if (msg.error) throw new Error(`MCP error on "${method}": ${msg.error.message}`)
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
    // End of session, without waiting or failing.
    void guardedRequest(serverUrl, { method: "DELETE", headers: { "mcp-session-id": sessionId, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, timeoutMs: 5_000 }, deps).catch(() => null)
  }
  const info = initResult.serverInfo
  return { server: info?.name ? `${info.name}${info.version ? ` ${info.version}` : ""}` : undefined, tools }
}
