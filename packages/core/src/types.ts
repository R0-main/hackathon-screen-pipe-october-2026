// Contrats partagés entre brain-sync (poste), le MCP, les hooks et le cerveau.
// Voir ARCHITECTURE.md § « Modèle de données ».

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

/** Ce que brain-sync envoie au cerveau (POST /api/ingest). */
export type KnowledgeItemInput = {
  zone: string
  kind: KnowledgeKind
  title: string
  body: string
  entities: Entity[]
  source: KnowledgeSource
  confidence: number
}

/** Un item tel que stocké dans le cerveau. */
export type KnowledgeItem = KnowledgeItemInput & {
  id: string
  org_id: string
  author_id: string
  created_at: string
  /** Identifiant d'une connaissance plus récente qui remplace celle-ci (décision revue, procédure mise à jour). */
  superseded_by?: string | null
}

/** Ce que les hooks / le MCP / brain-sync envoient (POST /api/events). */
export type AgentEventInput = {
  agent: AgentName
  type: AgentEventType
  zones?: string[]
  summary?: string
  /** Empreinte du prompt normalisé : sert à détecter les tâches répétitives sans stocker le prompt brut. */
  fingerprint?: string
  session_id?: string
  at?: string
}

/** Ce qui fait s'allumer le cerveau. */
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
  /** Personne à qui ce poste est rattaché dans l'organigramme ; absent pour la tête (ou les têtes). */
  manager_id?: string | null
  /** Droit de pousser des skills dans le cerveau (les admins l'ont toujours). */
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
  /** Tâche importée par un connecteur (linear, todoist) : son identifiant chez l'outil et le lien pour l'ouvrir. */
  external_source?: string
  external_id?: string
  external_url?: string
  created_at: string
  updated_at: string
}

export type AutomationStatus = "proposed" | "accepted" | "dismissed"
export type AutomationSuggestion = {
  id: string
  /** Clé stable (dédoublonnage entre deux détections). */
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
 * Compte rendu d'une synchronisation envoyé par le poste (POST /api/sync/report) à la fin de chaque `brain sync`,
 * réussie ou non : c'est ce que la page Supervision montre par poste. Jamais de contenu, seulement des compteurs.
 */
export type SyncReport = {
  /** Fin de la synchronisation (ISO). */
  at: string
  ok: boolean
  duration_ms: number
  items_sent: number
  duplicates: number
  /** Conversations lues par source (claude, codex, screenpipe). */
  conversations: Record<string, number>
  distiller: string
  /** Conversations que Claude n'a pas su distiller (retentées plus tard). */
  failed: number
  deferred: number
  /** Message d'erreur (masqué sur le poste) si `ok` est faux. */
  error?: string
  client_version?: string
  platform?: string
  /** Screenpipe joignable sur le poste au moment de la synchro (absent si la source n'est pas lue). */
  screenpipe?: boolean
}

export type SyncReportRow = SyncReport & { id: string; org_id: string; user_id: string }

/** État d'un poste vu par la supervision. */
export type PosteHealth = "never" | "ok" | "late" | "error"

/** Un fichier d'un skill : SKILL.md à la racine, ou un script qu'il utilise (`scripts/export.py`…). Texte seulement. */
export type SkillFile = { path: string; content: string }

/**
 * Un skill de l'entreprise (format Claude Code : un dossier avec SKILL.md et ses scripts), conservé dans le cerveau.
 * `zone` : le cortex auquel il est attribué ; seuls ceux qui lisent cette zone le reçoivent. null : toute l'entreprise.
 */
export type Skill = {
  id: string
  /** Nom du dossier installé dans ~/.claude/skills (minuscules, chiffres, tirets). Unique dans l'entreprise. */
  name: string
  description: string
  zone: string | null
  files: SkillFile[]
  author_id: string | null
  /** Dernière personne qui a publié une version. */
  updated_by: string | null
  version: number
  created_at: string
  updated_at: string
}
