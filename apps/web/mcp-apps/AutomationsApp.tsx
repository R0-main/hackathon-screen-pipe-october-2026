// show_automations: the dashboard's suggestions panel. An admin sets them up or dismisses them right here, through the
// MCP server (set_automation_status), with the same rights as the dashboard.

import type { App } from "@modelcontextprotocol/ext-apps"
import { AutomationsPanel, type AutomationActions } from "@/components/AutomationsPanel"
import type { AutomationsPayload } from "./types"

export function AutomationsApp({ app, data, onData }: { app: App; data: AutomationsPayload; onData: (next: AutomationsPayload) => void }) {
  const actions: AutomationActions = {
    setStatus: async (id, status) => {
      const r = await app.callServerTool({ name: "set_automation_status", arguments: { id, status } })
      const text = r.content?.find((c) => c.type === "text")?.text
      if (r.isError) throw new Error(text ?? "The brain refused.")
      if (r.structuredContent) onData(r.structuredContent as AutomationsPayload)
    },
  }
  return (
    <div className="bg-bone p-3">
      <AutomationsPanel automations={data.automations} names={data.names} zones={data.zones} isAdmin={data.can_manage} onChange={() => {}} actions={actions} />
    </div>
  )
}
