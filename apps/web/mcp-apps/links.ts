// Links of the MCP App: the brain's pages open in the browser, through the host (the iframe cannot navigate).

import type { App } from "@modelcontextprotocol/ext-apps"

let app: App | null = null
let base = ""

export function setLinkTarget(next: App, baseUrl: string) {
  app = next
  base = baseUrl.replace(/\/+$/, "")
}

/** `path`: a dashboard path ("/people/u1") or an absolute address. */
export function openBrainPage(path: string) {
  const url = /^https?:\/\//.test(path) ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`
  void app?.openLink({ url }).catch(() => {})
}
