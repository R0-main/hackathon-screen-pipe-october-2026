// The NOS Brainer MCP App: one view for show_brain, show_automations and show_team, picked by the tool result.
// Built by scripts/build-mcp-apps.ts (with app.css) into a single HTML file the company's MCP server serves (lib/mcp-apps.ts).

import { useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import type { McpUiDisplayMode, McpUiHostContext } from "@modelcontextprotocol/ext-apps"
import { useApp } from "@modelcontextprotocol/ext-apps/react"
import type { App } from "@modelcontextprotocol/ext-apps"
import { setLinkTarget, openBrainPage } from "./links"
import type { AppPayload } from "./types"
import { BrainApp } from "./BrainApp"
import { AutomationsApp } from "./AutomationsApp"
import { TeamApp } from "./TeamApp"

const TITLES: Record<AppPayload["view"], string> = { brain: "Company brain", automations: "Automations", team: "Team" }

function isPayload(v: unknown): v is AppPayload {
  const view = (v as { view?: unknown } | null)?.view
  return view === "brain" || view === "automations" || view === "team"
}

function Root() {
  const [payload, setPayload] = useState<AppPayload | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [host, setHost] = useState<McpUiHostContext | undefined>()
  const { app, error } = useApp({
    appInfo: { name: "NOS Brainer", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (a) => {
      a.ontoolresult = (r) => {
        if (isPayload(r.structuredContent)) {
          setLinkTarget(a, r.structuredContent.base_url)
          setPayload(r.structuredContent)
          setFailure(null)
        } else {
          setFailure(r.content?.find((c) => c.type === "text")?.text ?? "The brain did not answer.")
        }
      }
      a.onhostcontextchanged = (ctx) => setHost((prev) => ({ ...prev, ...ctx }))
    },
  })
  const context = host ?? app?.getHostContext()

  if (error) return <Notice>Could not connect to Claude: {error.message}</Notice>
  if (failure) return <Notice>{failure}</Notice>
  if (!app || !payload) return <Notice live>Opening the brain…</Notice>

  const fullscreen = context?.displayMode === "fullscreen"
  return (
    <Frame app={app} payload={payload} context={context} fullscreen={fullscreen}>
      {payload.view === "brain" && <BrainApp app={app} data={payload} fullscreen={fullscreen} />}
      {payload.view === "automations" && <AutomationsApp app={app} data={payload} onData={setPayload} />}
      {payload.view === "team" && <TeamApp data={payload} fullscreen={fullscreen} />}
    </Frame>
  )
}

/** Header: company, view, link to the dashboard page, full screen when the host offers it. */
function Frame(props: { app: App; payload: AppPayload; context: McpUiHostContext | undefined; fullscreen: boolean; children: ReactNode }) {
  const { app, payload, context, fullscreen } = props
  const canExpand = context?.availableDisplayModes?.includes("fullscreen")
  const toggle = () => {
    const mode: McpUiDisplayMode = fullscreen ? "inline" : "fullscreen"
    void app.requestDisplayMode({ mode }).catch(() => {})
  }
  return (
    <div className={`flex flex-col bg-surface ${fullscreen ? "h-dvh" : ""}`}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <p className="min-w-0 truncate text-[13px]">
          <span className="font-medium">{payload.org}</span>
          <span className="text-trace"> · {TITLES[payload.view]}</span>
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <button type="button" className="btn btn-sm" onClick={() => openBrainPage(payload.page)}>
            Open in NOS Brainer
          </button>
          {canExpand && (
            <button type="button" className="btn btn-sm" onClick={toggle}>
              {fullscreen ? "Exit full screen" : "Full screen"}
            </button>
          )}
        </div>
      </header>
      <div className={fullscreen ? "min-h-0 flex-1" : ""}>{props.children}</div>
    </div>
  )
}

function Notice({ children, live }: { children: ReactNode; live?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 bg-surface px-4 py-6 text-[13px] text-trace">
      {live && <span className="live-dot is-live" aria-hidden />}
      <span>{children}</span>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Root />)
