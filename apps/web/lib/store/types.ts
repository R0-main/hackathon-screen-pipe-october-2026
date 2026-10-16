import type {
  AgentEvent,
  AgentEventType,
  AutomationCandidate,
  AutomationStatus,
  AutomationSuggestion,
  CompanyStatus,
  EntityType,
  KnowledgeItem,
  KnowledgeItemInput,
  Org,
  Profile,
  Role,
  ScoredItem,
  Task,
  TaskStatus,
  Zone,
  ZoneAccess,
} from "@brain/core"

export type NewProfile = { name: string; email?: string; title?: string; role: Role; token_hash: string }
export type ProfilePatch = Partial<NewProfile>
export type NewItem = KnowledgeItemInput & { author_id: string; created_at?: string }
export type NewEvent = Omit<AgentEvent, "id" | "org_id">
export type NewTask = Omit<Task, "id" | "created_at" | "updated_at"> & { created_at?: string }

export type ZoneStat = { zone: string; count: number; last_at: string | null; contributors: number }
export type EntityStat = { type: EntityType; name: string; count: number; zones: string[] }

/** Contrat de stockage du cerveau : implémenté en fichier JSON (démo) et en Postgres (Supabase). */
export interface BrainStore {
  readonly kind: "file" | "postgres"

  getOrg(): Promise<Org>
  updateOrg(patch: Partial<Pick<Org, "name" | "description">>): Promise<Org>

  getProfileByTokenHash(hash: string): Promise<Profile | null>
  getProfile(id: string): Promise<Profile | null>
  listProfiles(): Promise<Profile[]>
  createProfile(p: NewProfile): Promise<Profile>
  updateProfile(id: string, patch: ProfilePatch): Promise<Profile | null>

  listZones(): Promise<Zone[]>
  upsertZone(z: Zone): Promise<Zone>
  listZoneAccess(userId?: string): Promise<ZoneAccess[]>
  setZoneAccess(userId: string, access: { zone_id: string; can_write: boolean }[]): Promise<void>

  insertItems(items: NewItem[]): Promise<KnowledgeItem[]>
  searchItems(query: string, zones: string[], limit: number): Promise<ScoredItem[]>
  listItems(f: { zones?: string[]; authorId?: string; limit?: number; sinceIso?: string }): Promise<KnowledgeItem[]>
  getItem(id: string): Promise<KnowledgeItem | null>
  deleteItem(id: string): Promise<boolean>
  zoneStats(): Promise<ZoneStat[]>
  topEntities(f: { zones?: string[]; authorId?: string; limit: number }): Promise<EntityStat[]>

  insertEvents(events: NewEvent[]): Promise<AgentEvent[]>
  /** `afterId` : ordre croissant (flux temps réel). Sinon : les plus récents d'abord. */
  listEvents(f: { afterId?: number; sinceIso?: string; limit?: number; type?: AgentEventType; userId?: string }): Promise<AgentEvent[]>

  listTasks(f: { zones?: string[]; assigneeId?: string }): Promise<Task[]>
  createTasks(tasks: NewTask[]): Promise<Task[]>
  updateTask(id: string, patch: { status?: TaskStatus; assignee_id?: string }): Promise<Task | null>

  listAutomations(): Promise<AutomationSuggestion[]>
  /** Insère ou met à jour par `key`, en conservant le statut (accepté / écarté) déjà choisi. */
  upsertAutomations(c: AutomationCandidate[]): Promise<AutomationSuggestion[]>
  updateAutomation(id: string, patch: { status: AutomationStatus }): Promise<AutomationSuggestion | null>

  getStatus(): Promise<CompanyStatus | null>
  setStatus(s: CompanyStatus): Promise<void>

  /** Vide tout (utilisé par le seed). */
  reset(org: { name: string; description: string }): Promise<void>
}
