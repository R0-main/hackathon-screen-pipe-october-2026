import type {
  AgentEvent,
  AgentEventType,
  AutomationCandidate,
  AutomationStatus,
  AutomationSuggestion,
  BrainDocument,
  BrainDocumentWithText,
  CompanyStatus,
  EntityType,
  KnowledgeItem,
  KnowledgeItemInput,
  Org,
  Profile,
  Role,
  ScoredDocument,
  ScoredItem,
  SearchFilter,
  Skill,
  SkillFile,
  SyncReport,
  SyncReportRow,
  Task,
  TaskStatus,
  Zone,
  ZoneAccess,
} from "@brain/core"

export type NewProfile = {
  name: string
  email?: string
  title?: string
  role: Role
  manager_id?: string | null
  can_publish_skills?: boolean
  token_hash: string
}
export type ProfilePatch = Partial<NewProfile>
export type NewItem = KnowledgeItemInput & { author_id: string; created_at?: string; embedding?: number[]; embedding_model?: string }
export type { SearchFilter }
export type NewEvent = Omit<AgentEvent, "id" | "org_id">
export type NewTask = Omit<Task, "id" | "created_at" | "updated_at"> & { created_at?: string }

/** New company created from the home page (/create): a separate brain, next to the base's. */
export type NewTenantOrg = { name: string; description: string; zones: Zone[] }

export type JoinStatus = "pending" | "accepted" | "rejected"
/** Request to join the company, sent through the team message. Fields the requester's Claude didn't know stay null. */
export type JoinRequest = {
  id: string
  org_id: string
  name: string | null
  title: string | null
  email: string | null
  hostname: string | null
  status: JoinStatus
  profile_id: string | null
  created_at: string
  decided_at: string | null
}
export type NewJoinRequest = { name?: string; title?: string; email?: string; hostname?: string; token_hash: string }

/** Publishing a skill: new name → version 1, existing name → next version (the original author is kept). */
export type NewSkill = { name: string; description: string; zone: string | null; files: SkillFile[]; publisher_id: string }

/** A document entering the brain: its metadata, its extracted text and its bytes. */
export type NewDocument = Omit<BrainDocumentWithText, "id" | "org_id" | "created_at"> & { content: Buffer; created_at?: string }

/**
 * `zones`: documents filed in these zones, plus those of `orAuthorId` whatever their zone (right of review); absent:
 * all zones. `itemIds`: documents backing at least one of these knowledge items.
 */
export type DocumentFilter = { zones?: string[]; orAuthorId?: string; zone?: string; itemIds?: string[]; limit?: number }

/** Sync reports kept per workstation. */
export const SYNC_REPORTS_KEEP = 30

export type ZoneStat = { zone: string; count: number; last_at: string | null; contributors: number }
/** Counts of what is filed in a zone. */
export type ZoneUsage = { items: number; tasks: number; documents: number; skills: number }
/** Volume of an author's knowledge in a zone: places each person in the brain. */
export type AuthorZoneStat = { author_id: string; zone: string; count: number }
export type EntityStat = { type: EntityType; name: string; count: number; zones: string[] }

/** Storage contract of the brain: implemented as a JSON file (demo) and in Postgres (Supabase). */
export interface BrainStore {
  readonly kind: "file" | "postgres"

  /**
   * Multi-company. The root store serves the "base" organization (the demo, the deployed brain); each
   * company created from /create is a "tenant" organization, served by `forOrg`. The methods below
   * only make sense on the root store.
   */
  forOrg(orgId: string): BrainStore
  createTenantOrg(o: NewTenantOrg): Promise<Org>
  countTenantOrgs(): Promise<number>
  /** All companies: the base's first, then the created companies (scheduled jobs). */
  listOrgIds(): Promise<string[]>
  /** An account's organization, across all companies (sign-in by token or by session). */
  findUserOrg(by: { id: string } | { tokenHash: string }): Promise<string | null>
  /** Company of a team code, or of a request to join it (root store). */
  findOrgByJoinCode(code: string): Promise<string | null>
  findJoinRequestOrg(id: string): Promise<string | null>

  /** Small setting of this company (text, JSON included), for example the onboarding proposed by an agent; null erases it. */
  getOrgSetting(name: string): Promise<string | null>
  setOrgSetting(name: string, value: string | null): Promise<void>

  /** Code of this company's team message (created on first call); `rotateJoinCode` invalidates the old message. */
  getJoinCode(): Promise<string>
  rotateJoinCode(): Promise<string>
  createJoinRequest(r: NewJoinRequest): Promise<JoinRequest>
  /** Most recent first. */
  listJoinRequests(f?: { status?: JoinStatus; limit?: number }): Promise<JoinRequest[]>
  getJoinRequest(id: string): Promise<(JoinRequest & { token_hash: string }) | null>
  decideJoinRequest(id: string, d: { status: Exclude<JoinStatus, "pending">; profile_id?: string }): Promise<JoinRequest | null>

  getOrg(): Promise<Org>
  updateOrg(patch: Partial<Pick<Org, "name" | "description">>): Promise<Org>

  getProfileByTokenHash(hash: string): Promise<Profile | null>
  getProfile(id: string): Promise<Profile | null>
  /** Fingerprint of a member's current token: dashboard sessions are tied to it (regenerating the token invalidates them). */
  getTokenHash(userId: string): Promise<string | null>
  listProfiles(): Promise<Profile[]>
  createProfile(p: NewProfile): Promise<Profile>
  updateProfile(id: string, patch: ProfilePatch): Promise<Profile | null>

  listZones(): Promise<Zone[]>
  upsertZone(z: Zone): Promise<Zone>
  /** `can_write` is kept but reserved: writing is not restricted (everyone feeds the brain). */
  listZoneAccess(userId?: string): Promise<ZoneAccess[]>
  setZoneAccess(userId: string, access: { zone_id: string; can_write: boolean }[]): Promise<void>
  /** What is still filed in a zone (superseded knowledge included): a zone is only deleted once it is empty. */
  zoneUsage(id: string): Promise<ZoneUsage>
  /**
   * Deletes a zone with its access rights; the automation suggestions filed in it lose their zone. Checks nothing:
   * the caller makes sure it is empty (zoneUsage) and not the core. False if it did not exist.
   */
  deleteZone(id: string): Promise<boolean>

  insertItems(items: NewItem[]): Promise<KnowledgeItem[]>
  /**
   * `authorId`: also includes this author's items, whatever their zone (right of review).
   * Superseded knowledge (superseded_by) is never returned. The keywords count, with a low weight.
   */
  searchItems(query: string, zones: string[], limit: number, opts?: { authorId?: string; filter?: SearchFilter }): Promise<ScoredItem[]>
  /** `excludeSuperseded`: without superseded knowledge (dashboard lists, status summary). */
  listItems(f: { zones?: string[]; authorId?: string; limit?: number; sinceIso?: string; excludeSuperseded?: boolean }): Promise<KnowledgeItem[]>
  getItem(id: string): Promise<KnowledgeItem | null>
  /** Deletes the knowledge item and the tasks drawn from it (not those imported from an external tool). False if it did not exist. */
  deleteItem(id: string): Promise<boolean>
  /** The author's knowledge drawn from these sessions (`session_id` without its `#n` chunk suffix, see sessionOf), superseded included. */
  listItemsBySessions(authorId: string, sessionIds: string[]): Promise<{ id: string; zone: string; session_id: string }[]>
  /** Files these items into `zone`, with the tasks derived from them; returns the number of items moved. */
  moveItems(ids: string[], zone: string): Promise<number>
  /**
   * Fixes a knowledge item (moderator): title, body, kind, zone. Its semantic vector is cleared (recomputed by the
   * embeddings job) and its tasks follow the zone. False if it no longer exists.
   */
  updateItem(id: string, patch: { title: string; body: string; kind: KnowledgeItem["kind"]; zone: string }): Promise<boolean>
  /**
   * Marks `oldId` as superseded by `newId` (a more recent item on the same subject). False if nothing was marked,
   * notably in Postgres until the "quality" migration is applied: ingestion never fails because of it.
   */
  markSuperseded(oldId: string, newId: string): Promise<boolean>
  /**
   * The knowledge graph around some entities (`type:normalized name` keys, see entityKey): the items (not superseded)
   * of the given zones, or by this author, that cite at least one of them, most recent first, and each key's degree:
   * how many of those items cite it in the whole scope, not only among the `limit` returned.
   */
  entityNeighborhood(f: { keys: string[]; zones: string[]; authorId?: string; limit?: number }): Promise<{ items: KnowledgeItem[]; degree: Record<string, number> }>
  /** Items (not superseded) citing an entity, in the given zones (or by this author). */
  listItemsByEntity(f: { type: string; normName: string; zones: string[]; authorId?: string; limit?: number }): Promise<KnowledgeItem[]>
  /** Semantic vectors of the non-superseded items of the given zones (most recent first), for ranking. */
  listEmbeddings(f: { zones: string[]; authorId?: string; limit?: number; filter?: SearchFilter }): Promise<{ id: string; embedding: number[] }[]>
  setEmbeddings(rows: { id: string; embedding: number[]; model: string }[]): Promise<void>
  /** Items without a vector (or from another model), for the catch-up (scripts/embed-backfill.ts). */
  listItemsWithoutEmbedding(model: string, limit: number): Promise<KnowledgeItem[]>
  /** Sets the search keywords of items (keywords.ts); an empty list clears them. */
  setKeywords(rows: { id: string; keywords: string[] }[]): Promise<void>
  zoneStats(): Promise<ZoneStat[]>
  authorZoneStats(): Promise<AuthorZoneStat[]>
  topEntities(f: { zones?: string[]; authorId?: string; limit: number }): Promise<EntityStat[]>

  insertEvents(events: NewEvent[]): Promise<AgentEvent[]>
  /** `afterId`: ascending order (real-time stream). Otherwise: most recent first. */
  listEvents(f: { afterId?: number; sinceIso?: string; limit?: number; type?: AgentEventType; userId?: string }): Promise<AgentEvent[]>
  /**
   * Real-time stream: `listener` is called as soon as events are inserted for the company `orgId` (by this
   * instance, or by another one in Postgres through LISTEN/NOTIFY). Returns the unsubscribe function. The stream keeps
   * a periodic safety re-read: a lost notification delays an event, it never makes it disappear.
   */
  onEvents(orgId: string, listener: () => void): () => void
  /** How the stream is notified: `local` (same process), `notify` (Postgres LISTEN), `poll` (re-read only). */
  eventNotifyMode(): "local" | "notify" | "poll"

  /** A workstation's sync report (monitoring); the history is bounded to SYNC_REPORTS_KEEP per workstation. */
  saveSyncReport(userId: string, report: SyncReport): Promise<SyncReportRow>
  /** The last report of each workstation (most recent first). */
  latestSyncReports(): Promise<SyncReportRow[]>
  listSyncReports(f: { userId?: string; limit?: number }): Promise<SyncReportRow[]>

  listTasks(f: { zones?: string[]; assigneeId?: string }): Promise<Task[]>
  createTasks(tasks: NewTask[]): Promise<Task[]>
  updateTask(id: string, patch: { status?: TaskStatus; assignee_id?: string }): Promise<Task | null>
  /**
   * A connector's tasks: inserted or updated by (source, external id); title, zone, status and link
   * follow the tool. A task of this source missing from `tasks` (closed or deleted in the tool) becomes "done".
   * Returns the tasks touched.
   */
  upsertExternalTasks(source: string, tasks: NewTask[]): Promise<Task[]>

  /** Documents (PDF, Word, Excel…) sent with the knowledge: metadata and text here, bytes apart. */
  insertDocument(d: NewDocument): Promise<BrainDocument>
  /** The document with this fingerprint (same file sent again), if the company already has it. */
  findDocumentBySha(sha256: string): Promise<BrainDocument | null>
  getDocument(id: string): Promise<BrainDocumentWithText | null>
  getDocumentContent(id: string): Promise<Buffer | null>
  /** Most recent first. */
  listDocuments(f: DocumentFilter): Promise<BrainDocument[]>
  /** Search on name, title and text, in the given zones (or by this author), like searchItems. */
  searchDocuments(query: string, zones: string[], limit: number, opts?: { authorId?: string }): Promise<ScoredDocument[]>
  /** Adds knowledge items to those the document backs (already linked ones are kept). Null if it no longer exists. */
  linkDocument(id: string, itemIds: string[]): Promise<BrainDocument | null>
  deleteDocument(id: string): Promise<boolean>

  listAutomations(): Promise<AutomationSuggestion[]>
  /** Inserts or updates by `key`, keeping the status (accepted / dismissed) already chosen. */
  upsertAutomations(c: AutomationCandidate[]): Promise<AutomationSuggestion[]>
  updateAutomation(id: string, patch: { status: AutomationStatus }): Promise<AutomationSuggestion | null>

  listSkills(): Promise<Skill[]>
  getSkill(id: string): Promise<Skill | null>
  getSkillByName(name: string): Promise<Skill | null>
  publishSkill(s: NewSkill): Promise<Skill>
  updateSkill(id: string, patch: { zone: string | null }): Promise<Skill | null>
  deleteSkill(id: string): Promise<boolean>

  getStatus(): Promise<CompanyStatus | null>
  setStatus(s: CompanyStatus): Promise<void>

  /** Session signing secret, generated randomly once then kept (600 file or brain_settings table). */
  getSessionSecret(): Promise<string>

  /**
   * "Only once" lock, shared across all instances (several Vercel functions in parallel):
   * true for the first caller only. `releaseClaim` releases it (if the protected task failed).
   */
  /** True if the brain does not contain any account yet (without creating anything, unlike the other reads). */
  isEmpty(): Promise<boolean>
  /**
   * Migrations applied in the database (Postgres): their number and the last one; null with file storage. `applied` is
   * 0 and `last` null if the tracking table does not exist yet (no migration applied by npm run db:migrate).
   */
  migrationStatus(): Promise<{ applied: number; last: string | null } | null>
  claimOnce(key: string): Promise<boolean>
  releaseClaim(key: string): Promise<void>
  /** Marks the protected task as done; `isClaimDone` lets the other instances wait for it. */
  finishClaim(key: string): Promise<void>
  isClaimDone(key: string): Promise<boolean>

  /** Empties everything (used by the seed). */
  reset(org: { name: string; description: string }): Promise<void>
}
