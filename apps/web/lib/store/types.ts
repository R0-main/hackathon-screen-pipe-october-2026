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
export type NewEvent = Omit<AgentEvent, "id" | "org_id">
export type NewTask = Omit<Task, "id" | "created_at" | "updated_at"> & { created_at?: string }

/** Nouvelle entreprise créée depuis la page d'accueil (/creer) : un cerveau à part, à côté de celui de la base. */
export type NewTenantOrg = { name: string; description: string; zones: Zone[] }

export type JoinStatus = "pending" | "accepted" | "rejected"
/** Demande pour rejoindre l'entreprise, envoyée par le message d'équipe. Les champs que le Claude du demandeur ne connaissait pas restent null. */
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

/** Publication d'un skill : nouveau nom → version 1, nom existant → version suivante (l'auteur d'origine est gardé). */
export type NewSkill = { name: string; description: string; zone: string | null; files: SkillFile[]; publisher_id: string }

/** Comptes rendus de synchro conservés par poste. */
export const SYNC_REPORTS_KEEP = 30

export type ZoneStat = { zone: string; count: number; last_at: string | null; contributors: number }
/** Volume de connaissances d'un auteur dans une zone : situe chaque personne dans le cerveau. */
export type AuthorZoneStat = { author_id: string; zone: string; count: number }
export type EntityStat = { type: EntityType; name: string; count: number; zones: string[] }

/** Contrat de stockage du cerveau : implémenté en fichier JSON (démo) et en Postgres (Supabase). */
export interface BrainStore {
  readonly kind: "file" | "postgres"

  /**
   * Multi-entreprise. Le stockage racine sert l'organisation « de la base » (la démo, le cerveau déployé) ; chaque
   * entreprise créée depuis /creer est une organisation « tenant », servie par `forOrg`. Les méthodes ci-dessous
   * n'ont de sens que sur le stockage racine.
   */
  forOrg(orgId: string): BrainStore
  createTenantOrg(o: NewTenantOrg): Promise<Org>
  countTenantOrgs(): Promise<number>
  /** Organisation d'un compte, toutes entreprises confondues (connexion par jeton ou par session). */
  findUserOrg(by: { id: string } | { tokenHash: string }): Promise<string | null>
  /** Entreprise d'un code d'équipe, ou d'une demande pour la rejoindre (stockage racine). */
  findOrgByJoinCode(code: string): Promise<string | null>
  findJoinRequestOrg(id: string): Promise<string | null>

  /** Petit réglage de cette entreprise (texte, JSON compris), par exemple l'onboarding proposé par un agent ; null l'efface. */
  getOrgSetting(name: string): Promise<string | null>
  setOrgSetting(name: string, value: string | null): Promise<void>

  /** Code du message d'équipe de cette entreprise (créé au premier appel) ; `rotateJoinCode` invalide l'ancien message. */
  getJoinCode(): Promise<string>
  rotateJoinCode(): Promise<string>
  createJoinRequest(r: NewJoinRequest): Promise<JoinRequest>
  /** Les plus récentes d'abord. */
  listJoinRequests(f?: { status?: JoinStatus; limit?: number }): Promise<JoinRequest[]>
  getJoinRequest(id: string): Promise<(JoinRequest & { token_hash: string }) | null>
  decideJoinRequest(id: string, d: { status: Exclude<JoinStatus, "pending">; profile_id?: string }): Promise<JoinRequest | null>

  getOrg(): Promise<Org>
  updateOrg(patch: Partial<Pick<Org, "name" | "description">>): Promise<Org>

  getProfileByTokenHash(hash: string): Promise<Profile | null>
  getProfile(id: string): Promise<Profile | null>
  /** Empreinte du jeton courant d'un membre : les sessions du dashboard y sont liées (régénérer le jeton les invalide). */
  getTokenHash(userId: string): Promise<string | null>
  listProfiles(): Promise<Profile[]>
  createProfile(p: NewProfile): Promise<Profile>
  updateProfile(id: string, patch: ProfilePatch): Promise<Profile | null>

  listZones(): Promise<Zone[]>
  upsertZone(z: Zone): Promise<Zone>
  /** `can_write` est conservé mais réservé : l'écriture n'est pas restreinte (tout le monde nourrit le cerveau). */
  listZoneAccess(userId?: string): Promise<ZoneAccess[]>
  setZoneAccess(userId: string, access: { zone_id: string; can_write: boolean }[]): Promise<void>

  insertItems(items: NewItem[]): Promise<KnowledgeItem[]>
  /**
   * `authorId` : inclut aussi les items de cet auteur, quelle que soit leur zone (droit de regard).
   * Les connaissances remplacées (superseded_by) ne sont jamais renvoyées.
   */
  searchItems(query: string, zones: string[], limit: number, opts?: { authorId?: string }): Promise<ScoredItem[]>
  /** `excludeSuperseded` : sans les connaissances remplacées (listes du dashboard, résumé d'état). */
  listItems(f: { zones?: string[]; authorId?: string; limit?: number; sinceIso?: string; excludeSuperseded?: boolean }): Promise<KnowledgeItem[]>
  getItem(id: string): Promise<KnowledgeItem | null>
  deleteItem(id: string): Promise<boolean>
  /** Marque `oldId` comme remplacée par `newId` (une connaissance plus récente sur le même sujet). */
  markSuperseded(oldId: string, newId: string): Promise<void>
  /** Connaissances (non remplacées) qui citent une entité, dans les zones données (ou de cet auteur). */
  listItemsByEntity(f: { type: string; normName: string; zones: string[]; authorId?: string; limit?: number }): Promise<KnowledgeItem[]>
  /** Vecteurs sémantiques des connaissances non remplacées des zones données (les plus récentes d'abord), pour le classement. */
  listEmbeddings(f: { zones: string[]; authorId?: string; limit?: number }): Promise<{ id: string; embedding: number[] }[]>
  setEmbeddings(rows: { id: string; embedding: number[]; model: string }[]): Promise<void>
  /** Connaissances sans vecteur (ou d'un autre modèle), pour le rattrapage (scripts/embed-backfill.ts). */
  listItemsWithoutEmbedding(model: string, limit: number): Promise<KnowledgeItem[]>
  zoneStats(): Promise<ZoneStat[]>
  authorZoneStats(): Promise<AuthorZoneStat[]>
  topEntities(f: { zones?: string[]; authorId?: string; limit: number }): Promise<EntityStat[]>

  insertEvents(events: NewEvent[]): Promise<AgentEvent[]>
  /** `afterId` : ordre croissant (flux temps réel). Sinon : les plus récents d'abord. */
  listEvents(f: { afterId?: number; sinceIso?: string; limit?: number; type?: AgentEventType; userId?: string }): Promise<AgentEvent[]>
  /**
   * Flux temps réel : `listener` est appelé dès que des événements sont insérés pour l'entreprise `orgId` (par cette
   * instance, ou par une autre en Postgres via LISTEN/NOTIFY). Renvoie la fonction de désabonnement. Le flux garde
   * une relecture périodique de sécurité : une notification perdue retarde un événement, elle ne le fait jamais disparaître.
   */
  onEvents(orgId: string, listener: () => void): () => void
  /** Comment le flux est prévenu : `local` (même processus), `notify` (Postgres LISTEN), `poll` (relecture seule). */
  eventNotifyMode(): "local" | "notify" | "poll"

  /** Compte rendu de synchro d'un poste (supervision) ; l'historique est borné à SYNC_REPORTS_KEEP par poste. */
  saveSyncReport(userId: string, report: SyncReport): Promise<SyncReportRow>
  /** Le dernier compte rendu de chaque poste (les plus récents d'abord). */
  latestSyncReports(): Promise<SyncReportRow[]>
  listSyncReports(f: { userId?: string; limit?: number }): Promise<SyncReportRow[]>

  listTasks(f: { zones?: string[]; assigneeId?: string }): Promise<Task[]>
  createTasks(tasks: NewTask[]): Promise<Task[]>
  updateTask(id: string, patch: { status?: TaskStatus; assignee_id?: string }): Promise<Task | null>
  /**
   * Tâches d'un connecteur : insérées ou mises à jour par (source, identifiant externe) ; titre, zone, statut et lien
   * suivent l'outil. Une tâche de cette source absente de `tasks` (fermée ou supprimée chez l'outil) passe « done ».
   * Renvoie les tâches touchées.
   */
  upsertExternalTasks(source: string, tasks: NewTask[]): Promise<Task[]>

  listAutomations(): Promise<AutomationSuggestion[]>
  /** Insère ou met à jour par `key`, en conservant le statut (accepté / écarté) déjà choisi. */
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

  /** Secret de signature des sessions, généré aléatoirement une seule fois puis conservé (fichier 600 ou table brain_settings). */
  getSessionSecret(): Promise<string>

  /**
   * Verrou « une seule fois », partagé entre toutes les instances (plusieurs fonctions Vercel en parallèle) :
   * vrai pour le premier appelant uniquement. `releaseClaim` le rend (si la tâche protégée a échoué).
   */
  /** Vrai si le cerveau ne contient encore aucun compte (sans rien créer, contrairement aux autres lectures). */
  isEmpty(): Promise<boolean>
  claimOnce(key: string): Promise<boolean>
  releaseClaim(key: string): Promise<void>
  /** Marque la tâche protégée comme terminée ; `isClaimDone` permet aux autres instances de l'attendre. */
  finishClaim(key: string): Promise<void>
  isClaimDone(key: string): Promise<boolean>

  /** Vide tout (utilisé par le seed). */
  reset(org: { name: string; description: string }): Promise<void>
}
