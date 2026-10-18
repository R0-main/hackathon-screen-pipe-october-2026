// MCP Apps of the company's MCP endpoint: show_brain, show_automations and show_team answer like the other tools (a
// markdown text, all Claude Code shows) and, in clients that render MCP Apps (Claude on the web and desktop), open the
// dashboard's view in the conversation: the 3D brain with its live agents, the automations to set up, the org chart.
// The view (mcp-apps/, built by scripts/build-mcp-apps.ts) only talks to this server: same token, same rights.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server"
import type { AgentEvent } from "@brain/core"
import { AGENT_LABEL } from "@/components/format"
import type { ActivityPayload, AutomationsPayload, BrainPayload, TeamPayload } from "@/mcp-apps/types"
import { viewerFromRequest, type Viewer } from "./auth"
import { getState, visibleEvent } from "./brain"
import { getStore, runInOrg } from "./store"

const APP_URI = "ui://nos-brainer/app.html"
/** Built next to the app (`next dev` / `next build` run in apps/web); next.config.mjs ships it with the MCP functions. */
const APP_FILE = join(process.cwd(), ".mcp-apps", "app.html")
/** The view's only outside resources: its two fonts. */
const FONT_DOMAINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"]
/** A workstation is active if its agent worked in the last 15 minutes (as on the dashboard). */
const ACTIVE_MS = 15 * 60_000

let built: string | null = null
function appHtml(): string {
  if (built) return built
  try {
    const html = readFileSync(APP_FILE, "utf8")
    // In development, the view is rebuilt without restarting the server: read again each time.
    if (process.env.NODE_ENV === "production") built = html
    return html
  } catch {
    throw new Error("The MCP App is not built: run `npm run build:mcp-apps -w @brain/web`.")
  }
}

type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }

const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true })

export type BrainAppsContext = { token: string; baseUrl: string; org: string }

/** Registers the view and its tools on the company's MCP server (`ctx`: the caller's token and the brain's address). */
export function registerBrainApps(server: McpServer, ctx: BrainAppsContext) {
  // The token's viewer, in its company: the same rights as the API routes the other tools call.
  const asViewer = async (fn: (viewer: Viewer) => Promise<Result>): Promise<Result> => {
    try {
      const viewer = await viewerFromRequest(new Request("http://brain.local/mcp", { headers: { authorization: `Bearer ${ctx.token}` } }))
      if (!viewer) return fail("Invalid token for this company: rerun `brain setup` with a valid token.")
      return await runInOrg(viewer.real.org_id, () => fn(viewer))
    } catch (err) {
      return fail(`Company brain error: ${(err as Error).message}`)
    }
  }
  const common = (page: string) => ({ base_url: ctx.baseUrl, page, org: ctx.org })
  const ui = { ui: { resourceUri: APP_URI } }
  const appOnly = { ui: { resourceUri: APP_URI, visibility: ["app" as const] } }

  registerAppResource(server, "NOS Brainer", APP_URI, { description: "The company brain's views: brain, automations, team." }, async () => ({
    contents: [{ uri: APP_URI, mimeType: RESOURCE_MIME_TYPE, text: appHtml(), _meta: { ui: { csp: { resourceDomains: FONT_DOMAINS }, prefersBorder: true } } }],
  }))

  registerAppTool(
    server,
    "show_brain",
    {
      title: "Show the company brain",
      description:
        "Shows the company brain as on the dashboard: its zones in 3D, the links between them and the team's agents lighting " +
        "them up live. Use it when the user asks to see the brain, what the team is working on right now, or who works where.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: ui,
    },
    async () =>
      asViewer(async (viewer) => {
        const s = await getState(viewer)
        const now = Date.now()
        const active = new Set(s.events.filter((e) => e.type !== "stopped" && Date.parse(e.at) > now - ACTIVE_MS).map((e) => e.user_id))
        const payload: BrainPayload = {
          view: "brain",
          ...common("/dashboard"),
          me: s.me.id,
          zones: s.zones,
          synapses: s.synapses,
          people: s.people.map((p) => ({ id: p.id, name: p.name, title: p.title, zone: p.zone })),
          names: s.names,
          events: s.events,
          totals: { items: s.totals.items, people: s.people.length },
        }
        const zones = s.zones.map((z) => `- ${z.name}: ${z.locked ? "not accessible" : `${z.count} knowledge item${z.count === 1 ? "" : "s"}`}`)
        const who = [...active].map((id) => s.names[id]).filter(Boolean)
        const text =
          `## ${s.org.name}'s brain\n${s.totals.items} knowledge items in ${s.zones.length} zones, ${s.people.length} people.\n\n${zones.join("\n")}\n\n` +
          (who.length ? `Agents active in the last 15 minutes: ${who.join(", ")}.` : "No agent active in the last 15 minutes.")
        return { content: [{ type: "text", text }], structuredContent: payload }
      }),
  )

  registerAppTool(
    server,
    "brain_activity",
    {
      title: "Brain activity since an event",
      description: "Used by the brain's view to light up the zones live: the team's agent events after the event `after`.",
      inputSchema: { after: z.number().int().min(0).describe("Id of the last event already received.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: appOnly,
    },
    async ({ after }) =>
      asViewer(async (viewer) => {
        const store = getStore()
        const [events, profiles] = await Promise.all([store.listEvents({ afterId: after, limit: 50 }), store.listProfiles()])
        const ids = new Set(events.map((e) => e.user_id))
        const payload: ActivityPayload = {
          events: events.map((e) => visibleEvent(viewer, e)),
          names: Object.fromEntries(profiles.filter((p) => ids.has(p.id)).map((p) => [p.id, p.name])),
        }
        return { content: [{ type: "text", text: `${events.length} new event${events.length === 1 ? "" : "s"}.` }], structuredContent: payload }
      }),
  )

  // Suggestions: an admin sees the whole team's, the others their own (as GET /api/automations).
  const automations = async (viewer: Viewer): Promise<Result> => {
    const store = getStore()
    const [all, profiles, zones] = await Promise.all([store.listAutomations(), store.listProfiles(), store.listZones()])
    const list = all.filter((a) => viewer.access.isAdmin || a.user_id === viewer.profile.id)
    const names = Object.fromEntries(profiles.map((p) => [p.id, p.name]))
    const payload: AutomationsPayload = { view: "automations", ...common("/automations"), can_manage: viewer.real.role === "admin", automations: list, names, zones }
    const open = list.filter((a) => a.status !== "dismissed")
    const lines = open.map(
      (a) =>
        `- **${a.title}** (${a.status === "accepted" ? "set up" : "proposed"}, \`${a.id}\`)` +
        `${a.user_id && names[a.user_id] ? `: ${names[a.user_id]}` : ""}${a.schedule ? `, ${a.schedule}` : ""}, ${a.minutes_saved_per_week} min per week`,
    )
    const text = open.length
      ? `## Suggested automations\n${lines.join("\n")}${payload.can_manage ? "" : "\n\nOnly an admin can set them up."}`
      : "No automation suggested yet: the brain spots prompts run by the same person, in the same time slot, several days in a row."
    return { content: [{ type: "text", text }], structuredContent: payload }
  }

  registerAppTool(
    server,
    "show_automations",
    {
      title: "Show the suggested automations",
      description:
        "Shows the automations the brain suggests from the team's repeated work (a prompt run every morning, a weekly report…), " +
        "with who does it, when, and the time saved. An admin sets them up or dismisses them in the view.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: ui,
    },
    async () => asViewer(automations),
  )

  registerAppTool(
    server,
    "set_automation_status",
    {
      title: "Set up or dismiss an automation",
      description: "Admins only: sets up (accepted) or dismisses a suggested automation, by its id (given by show_automations).",
      inputSchema: { id: z.string().min(1).max(200), status: z.enum(["accepted", "dismissed", "proposed"]) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: appOnly,
    },
    async ({ id, status }) =>
      asViewer(async (viewer) => {
        if (viewer.real.role !== "admin") return fail("Only an admin can set up or dismiss an automation.")
        if (!(await getStore().updateAutomation(id, { status }))) return fail("Suggestion not found.")
        return automations(viewer)
      }),
  )

  registerAppTool(
    server,
    "show_team",
    {
      title: "Show the team's org chart",
      description:
        "Shows the company's org chart: who reports to whom, job titles, and which workstations have an agent working right now. " +
        "Use it when the user asks who is in the team, who to ask, or who manages whom.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: ui,
    },
    async () =>
      asViewer(async (viewer) => {
        const store = getStore()
        const isAdmin = viewer.real.role === "admin"
        const [profiles, access, zones, events] = await Promise.all([store.listProfiles(), store.listZoneAccess(), store.listZones(), store.listEvents({ limit: 200 })])
        // Who reads which zone is the admins' business (Team and access): the others see the org chart without it.
        const users = profiles.map(({ email: _email, ...p }) => ({ ...p, zones: isAdmin ? access.filter((a) => a.user_id === p.id).map((a) => a.zone_id) : [] }))
        const payload: TeamPayload = {
          view: "team",
          ...common(isAdmin ? "/admin" : `/people/${viewer.real.id}`),
          me: viewer.real.id,
          users,
          with_zones: isAdmin,
          zones,
          presence: presenceOf(events),
        }
        return { content: [{ type: "text", text: orgChartText(payload) }], structuredContent: payload }
      }),
  )

  // Slash commands: Claude Code lists them as /mcp__<server>__show_brain…, Claude in its "+" menu.
  const command = (name: string, title: string, description: string, ask: string) =>
    server.registerPrompt(name, { title, description }, () => ({ messages: [{ role: "user", content: { type: "text", text: ask } }] }))
  command("show_brain", "Show the brain", "The company brain and the agents working in it right now.", "Show me the company brain (show_brain tool).")
  command("show_automations", "Show the automations", "The automations suggested from the team's repeated work.", "Show me the suggested automations (show_automations tool).")
  command("show_team", "Show the team", "The team's org chart.", "Show me the team's org chart (show_team tool).")
}

/** Presence of each workstation from its last events: active in the last 15 minutes, coding agents used. */
function presenceOf(events: AgentEvent[]): TeamPayload["presence"] {
  const out: TeamPayload["presence"] = {}
  const now = Date.now()
  for (const e of [...events].sort((a, b) => b.id - a.id)) {
    let p = out[e.user_id]
    if (!p) p = out[e.user_id] = { active: e.type !== "stopped" && Date.parse(e.at) > now - ACTIVE_MS, agents: [] }
    if ((e.agent === "claude-code" || e.agent === "codex") && !p.agents.includes(AGENT_LABEL[e.agent])) p.agents.push(AGENT_LABEL[e.agent])
  }
  return out
}

/** The org chart as an indented list, heads first (what Claude Code shows, and what the model reads). */
function orgChartText(t: TeamPayload): string {
  const byId = new Map(t.users.map((u) => [u.id, u]))
  const kids = new Map<string, TeamPayload["users"]>()
  for (const u of t.users) if (u.manager_id && u.manager_id !== u.id && byId.has(u.manager_id)) kids.set(u.manager_id, [...(kids.get(u.manager_id) ?? []), u])
  const seen = new Set<string>()
  const lines: string[] = []
  const walk = (u: TeamPayload["users"][number], depth: number) => {
    if (seen.has(u.id)) return
    seen.add(u.id)
    const role = u.title || (u.role === "admin" ? "Admin" : "Member")
    lines.push(`${"  ".repeat(depth)}- ${u.name}, ${role}${t.presence[u.id]?.active ? " (agent active)" : ""}`)
    for (const k of kids.get(u.id) ?? []) walk(k, depth + 1)
  }
  for (const u of t.users) if (!u.manager_id || !byId.has(u.manager_id) || u.manager_id === u.id) walk(u, 0)
  for (const u of t.users) walk(u, 0)
  return `## ${t.org}'s team (${t.users.length} ${t.users.length === 1 ? "person" : "people"})\n${lines.join("\n")}`
}
