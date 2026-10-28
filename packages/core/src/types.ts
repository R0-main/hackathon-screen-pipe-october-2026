// Contracts shared by brain-sync (on the workstation), the MCP server, the hooks and the brain.
// See ARCHITECTURE.md, "Data model".

export const KNOWLEDGE_KINDS = ["fact", "decision", "task", "procedure", "question"] as const
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]

export const ENTITY_TYPES = ["person", "project", "client", "tool", "doc"] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

export const SOURCE_TOOLS = ["claude-code", "codex", "chatgpt", "claude", "meeting", "onboarding", "agent", "connector"] as const
export type SourceTool = (typeof SOURCE_TOOLS)[number]

export const AGENTS = ["claude-code", "codex", "brain-sync", "job", "dashboard", "mcp"] as const
export type AgentName = (typeof AGENTS)[number]

export const EVENT_TYPES = ["started", "query", "write", "stopped"] as const
export type AgentEventType = (typeof EVENT_TYPES)[number]

export type Entity = { type: EntityType; name: string }

export type KnowledgeSource = {
  app: string
  tool: SourceTool
  at: string
  screenpipe_ref?: string
  session_id?: string
}

/** What brain-sync sends to the brain (POST /api/ingest). */
export type KnowledgeItemInput = {
  zone: string
  kind: KnowledgeKind
  title: string
  body: string
  entities: Entity[]
  source: KnowledgeSource
  confidence: number
  /**
   * Search terms its text does not contain (synonyms, the question it answers, French terms), written by a model for
   * this item alone (keywords.ts). Indexed apart with a low weight; absent until computed.
   */
  keywords?: string[]
}

/** An item as stored in the brain. */
export type KnowledgeItem = KnowledgeItemInput & {
  id: string
  org_id: string
  author_id: string
  created_at: string
  /** Id of a newer piece of knowledge that replaces this one (revised decision, updated procedure). */
  superseded_by?: string | null
}

/** What the hooks, the MCP server and brain-sync send (POST /api/events). */
export type AgentEventInput = {
  agent: AgentName
  type: AgentEventType
  zones?: string[]
  summary?: string
  /** Fingerprint of the normalized prompt: spots repetitive tasks without storing the raw prompt. */
  fingerprint?: string
  session_id?: string
  at?: string
}

/** What makes the brain light up. */
export type AgentEvent = {
  id: number
  org_id: string
  user_id: string
  agent: AgentName
  type: AgentEventType
  zones: string[]
  summary?: string
  fingerprint?: string
  session_id?: string
  at: string
}

export type Role = "admin" | "member"

export type Profile = {
  id: string
  org_id: string
  name: string
  email?: string
  title?: string
  role: Role
  /** Person this seat reports to in the org chart; absent for the head (or heads). */
  manager_id?: string | null
  /** Allowed to push skills into the brain (admins always are). */
  can_publish_skills?: boolean
  created_at: string
}

export type Zone = {
  id: string
  name: string
  description: string
  color: string
  keywords: string[]
  position: number
  /**
   * Projects whose AI sessions always land in this zone: folder names or git repositories (`owner/repo`), see
   * projectZone. Absent from a brain created before them.
   */
  projects?: string[]
}

export type ZoneAccess = { user_id: string; zone_id: string; can_write: boolean }

export type Org = { id: string; name: string; description: string; created_at: string }

export type TaskStatus = "open" | "done"
export type Task = {
  id: string
  title: string
  zone: string
  assignee_id?: string
  status: TaskStatus
  source_item_id?: string
  /** Task imported by a connector (linear, todoist): its id in that tool and the link to open it. */
  external_source?: string
  external_id?: string
  external_url?: string
  created_at: string
  updated_at: string
}

export type AutomationStatus = "proposed" | "accepted" | "dismissed"
export type AutomationSuggestion = {
  id: string
  /** Stable key (deduplication between two detections). */
  key: string
  user_id?: string
  zone?: string
  title: string
  description: string
  schedule?: string
  evidence: { occurrences: number; days: number; sample?: string; times?: string[] }
  minutes_saved_per_week: number
  status: AutomationStatus
  source: "heuristic" | "screenpipe"
  created_at: string
}

export type ZoneStatus = {
  zone: string
  summary: string
  objectives: string[]
  progress: string
  next_steps: string[]
  who_did_what: { person: string; did: string }[]
}

export type CompanyStatus = {
  headline: string
  zones: ZoneStatus[]
  generated_at: string
  generator: "claude" | "heuristic"
}

export type ScoredItem = KnowledgeItem & { score: number }

/**
 * Sync report sent by the workstation (POST /api/sync/report) at the end of every `brain sync`, successful or not:
 * this is what the Monitoring page shows per workstation. Never any content, only counters.
 */
export type SyncReport = {
  /** End of the sync (ISO). */
  at: string
  ok: boolean
  duration_ms: number
  items_sent: number
  duplicates: number
  /** Conversations read per source (claude, codex, screenpipe). */
  conversations: Record<string, number>
  distiller: string
  /** Conversations Claude could not distill (retried later). */
  failed: number
  deferred: number
  /** Error message (redacted on the workstation) when `ok` is false. */
  error?: string
  client_version?: string
  platform?: string
  /** Screenpipe reachable on the workstation at sync time (absent when that source is not read). */
  screenpipe?: boolean
}

export type SyncReportRow = SyncReport & { id: string; org_id: string; user_id: string }

/** Health of a workstation as seen by monitoring. */
export type WorkstationHealth = "never" | "ok" | "late" | "error"

/** A file of a skill: SKILL.md at the root, or a script it uses (`scripts/export.py`…). Text only. */
export type SkillFile = { path: string; content: string }

/**
 * A company skill (Claude Code format: a folder with SKILL.md and its scripts), kept in the brain.
 * `zone`: the cortex it is assigned to; only people who read that zone receive it. null: the whole company.
 */
export type Skill = {
  id: string
  /** Name of the folder installed in ~/.claude/skills (lowercase, digits, dashes). Unique within the company. */
  name: string
  description: string
  zone: string | null
  files: SkillFile[]
  author_id: string | null
  /** Last person who published a version. */
  updated_by: string | null
  version: number
  created_at: string
  updated_at: string
}
