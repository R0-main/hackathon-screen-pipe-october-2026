// What the MCP App tools send to their view (structuredContent): read by lib/mcp-apps.ts (server) and the view.
// Types only: the server does not bundle the view, and the view never imports server code.

import type { AgentEvent, AutomationSuggestion, Profile, Zone } from "@brain/core"
import type { ZoneView } from "@/lib/brain"

export type BrainEvent = AgentEvent & { restricted?: boolean; restricted_reason?: "zone" | "private" }

/** Every payload: the brain's address and the dashboard page the header link opens. */
type Common = { base_url: string; page: string; org: string }

export type BrainPayload = Common & {
  view: "brain"
  me: string
  zones: ZoneView[]
  synapses: { a: string; b: string; weight: number; via: string[] }[]
  people: { id: string; name: string; title?: string; zone: string | null }[]
  names: Record<string, string>
  events: BrainEvent[]
  totals: { items: number; people: number }
}

/** brain_activity (called by the view, not the model): the events after `after`. */
export type ActivityPayload = { events: BrainEvent[]; names: Record<string, string> }

export type AutomationsPayload = Common & {
  view: "automations"
  /** Admin: can set up or dismiss a suggestion. Others only see their own. */
  can_manage: boolean
  automations: AutomationSuggestion[]
  names: Record<string, string>
  zones: Zone[]
}

/** A member of the org chart: their profile without their email, and the zones they can read. */
export type TeamUser = Omit<Profile, "email"> & { zones: string[] }

export type TeamPayload = Common & {
  view: "team"
  me: string
  users: TeamUser[]
  /** The zones each person reads: admins only (Team and access). */
  with_zones: boolean
  zones: Zone[]
  presence: Record<string, { active: boolean; agents: string[] }>
}

export type AppPayload = BrainPayload | AutomationsPayload | TeamPayload
