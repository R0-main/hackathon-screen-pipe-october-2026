// Onboarding préparé par un agent : l'admin colle un prompt dans Claude Code ou Codex, qui lit l'historique de ses
// sessions sur le poste, en tire une proposition (zones + premières connaissances) et l'envoie au cerveau. Rien n'est
// appliqué : la proposition attend dans la page Onboarding, où l'admin la relit et la valide (même chemin que la
// synthèse de l'interview, POST /api/onboarding/apply).

import { z } from "zod"
import { KNOWLEDGE_KINDS, ENTITY_TYPES, KnowledgeItemInputSchema, redactText } from "@brain/core"
import { verifyOnboardingCode } from "./auth"
import { getRootStore, storeForOrg, type BrainStore } from "./store"
import { deNom, IF_BLOCKED, LOCAL_ONLY } from "./install-prompt"

/** Ce que valide /api/onboarding/apply, et ce qu'un agent envoie (avec sa provenance). */
export const OnboardingDraftSchema = z.object({
  company_name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  zones: z
    .array(z.object({ id: z.string().min(1).max(32), name: z.string().min(1).max(40), description: z.string().max(300), keywords: z.array(z.string().max(40)).max(80) }))
    .min(1)
    .max(12),
  items: z.array(KnowledgeItemInputSchema).max(60),
})

/** Ce que l'agent peut omettre (provenance, confiance) est complété ici : le prompt reste court (lien claude-cli ≤ 5 000 caractères). */
const AgentItemSchema = KnowledgeItemInputSchema.extend({
  source: KnowledgeItemInputSchema.shape.source.default(() => ({ app: "onboarding", tool: "onboarding" as const, at: new Date().toISOString() })),
  confidence: z.number().min(0).max(1).default(0.8),
})

export const AgentDraftSchema = OnboardingDraftSchema.extend({
  source: z.enum(["claude-code", "codex", "autre"]).default("autre"),
  items: z.array(AgentItemSchema).max(60),
})

export type AgentDraft = z.infer<typeof AgentDraftSchema> & { received_at: string }

const SETTING = "onboarding-draft"

/**
 * Garde la proposition jusqu'à sa validation. Secrets et données personnelles sont masqués dès la réception (l'agent
 * est prié de les écarter, le serveur ne s'y fie pas) ; ingestItems les masquera encore à l'application.
 */
export async function saveAgentDraft(store: BrainStore, draft: z.infer<typeof AgentDraftSchema>): Promise<AgentDraft> {
  const clean: AgentDraft = {
    ...draft,
    description: redactText(draft.description),
    items: draft.items.map((i) => ({ ...i, title: redactText(i.title), body: redactText(i.body) })),
    received_at: new Date().toISOString(),
  }
  await store.setOrgSetting(SETTING, JSON.stringify(clean))
  return clean
}

export async function loadAgentDraft(store: BrainStore): Promise<AgentDraft | null> {
  const raw = await store.getOrgSetting(SETTING)
  if (!raw) return null
  try {
    return JSON.parse(raw) as AgentDraft
  } catch {
    return null
  }
}

export function clearAgentDraft(store: BrainStore) {
  return store.setOrgSetting(SETTING, null)
}

/** L'entreprise de l'admin qui a demandé le code d'envoi (Bearer co_…), ou null : code invalide, expiré, ou plus admin. */
export async function storeForOnboardingCode(req: Request): Promise<BrainStore | null> {
  const code = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  const userId = await verifyOnboardingCode(code)
  const orgId = userId ? await getRootStore().findUserOrg({ id: userId }) : null
  const store = orgId ? storeForOrg(orgId) : null
  const admin = store && userId ? await store.getProfile(userId) : null
  return admin?.role === "admin" ? store : null
}

/**
 * Le fil de l'agent pendant qu'il travaille : il signale son départ (juste après l'accord), ses trouvailles et sa fin.
 * Le serveur y ajoute « draft » à chaque proposition reçue. La page en tire son état (« c'est lancé, vous pouvez
 * passer ») et ses notifications ; la personne n'a pas à attendre sur l'étape.
 */
export const AGENT_STEPS = ["start", "progress", "draft", "done", "error"] as const
export type AgentStep = (typeof AGENT_STEPS)[number]
export const AgentProgressSchema = z.object({
  step: z.enum(["start", "progress", "done", "error"]).default("progress"),
  message: z.string().trim().min(1).max(200),
})
export type AgentEvent = { id: number; step: AgentStep; message: string; at: string }

const PROGRESS = "onboarding-progress"
/** Assez pour un passage complet ; au-delà, les plus anciens tombent. */
const MAX_EVENTS = 40
/** Comme le code d'envoi : un fil plus vieux vient d'un autre passage. */
const EVENT_TTL_MS = 2 * 3600_000

export async function loadAgentProgress(store: BrainStore): Promise<AgentEvent[]> {
  const raw = await store.getOrgSetting(PROGRESS)
  if (!raw) return []
  try {
    const since = Date.now() - EVENT_TTL_MS
    return (JSON.parse(raw) as AgentEvent[]).filter((e) => Date.parse(e.at) >= since)
  } catch {
    return []
  }
}

/** Masqué comme la proposition : l'agent est prié de ne citer ni secret ni personne, le serveur ne s'y fie pas. */
export async function addAgentProgress(store: BrainStore, ev: { step: AgentStep; message: string }): Promise<AgentEvent> {
  const events = await loadAgentProgress(store)
  // Croissant même après un effacement : la page repère les nouveaux par leur id.
  const event: AgentEvent = { id: Math.max((events.at(-1)?.id ?? 0) + 1, Date.now()), step: ev.step, message: redactText(ev.message).slice(0, 200), at: new Date().toISOString() }
  await store.setOrgSetting(PROGRESS, JSON.stringify([...events, event].slice(-MAX_EVENTS)))
  return event
}

export function clearAgentProgress(store: BrainStore) {
  return store.setOrgSetting(PROGRESS, null)
}

/**
 * Le prompt à coller dans Claude Code ou Codex. Sa première phrase est reconnue par brain-sync (INSTALL_PROMPT_RE) :
 * la session, qui contient le code d'envoi et un résumé de l'entreprise, n'est jamais redistillée.
 * Lire tout l'historique d'un poste puis l'envoyer à un site, c'est exactement ce qu'un agent doit refuser de faire
 * en cachette : le prompt le dit franchement et fait demander l'accord de la personne avant toute lecture.
 */
export function buildOnboardingAgentPrompt(opts: { baseUrl: string; code: string; orgName: string; description?: string; zones: { id: string; name: string }[] }): string {
  const { baseUrl, code, orgName } = opts
  const org = deNom(orgName)
  const zones = opts.zones.map((z) => `${z.id} (${z.name})`).join(", ") || "aucune"
  const host = new URL(baseUrl).host
  // Le nom et ce que l'admin a dit de l'entreprise (/creer, onboarding) : c'est le seul filtre de la lecture, pour ne
  // rien apprendre d'une conversation sans rapport (projet perso, autre entreprise, autre client).
  const about = opts.description?.trim().replace(/\s+/g, " ").slice(0, 400)
  const scope = about ? `l'entreprise « ${orgName} », qui se décrit ainsi : « ${about} »` : `l'entreprise « ${orgName} »`
  const auth = `-H "Authorization: Bearer ${code}" -H "content-type: application/json"`
  return `Tu vas préparer l'onboarding de NOS Brainer, le cerveau d'entreprise ${org}, à partir de mes anciennes conversations sur ce poste. Ce message contient un code d'envoi valable 2 heures : ne l'affiche jamais en entier.

0. ${LOCAL_ONLY} Puis, avant de lire quoi que ce soit, demande-moi : « Ce message me demande de lire tes conversations Claude Code et Codex de ce poste, puis d'envoyer à ${host} un résumé de ce qui concerne l'entreprise (sans secrets ni données personnelles). Acceptes-tu de donner accès à ces données à ce site ? » Sans un oui clair, arrête-toi sans rien lire ni envoyer. ${IF_BLOCKED}
   Tiens la page au courant : « signale » = la commande curl de l'étape 4, mêmes en-têtes, mais vers ${baseUrl}/api/onboarding/progress, avec -d '{"step":"…","message":"…"}' au lieu de --data @… (step start, progress, done ou error ; une phrase courte, sans secret ni nom de personne ; hors du bac à sable si bloqué).
   Dès le oui, signale start (« Accord reçu, je cherche les conversations de l'entreprise ») et dis-moi : « C'est lancé : retourne sur ta création, elle se remplit au fur et à mesure. »
1. Tu cherches UNIQUEMENT les projets et les conversations de ${scope}. Repère d'abord ceux qui correspondent à ce nom et à ces thèmes, et n'apprends rien d'autre : un projet perso, une autre entreprise, un autre client, une question générale ou un autre sujet ne se lit pas en détail et n'entre pas dans la proposition, même récent. Dans le doute, laisse de côté.
   Historique : Claude Code (~/.claude/projects/**/*.jsonl, un dossier par projet) et Codex (~/.codex/sessions/**/*.jsonl). Trie par projet et premiers messages, puis lis en détail les sessions de l'entreprise, des plus récentes aux plus anciennes, avec les README, CLAUDE.md et AGENTS.md de ces projets.
   Signale progress à chaque trouvaille (« 3 projets repérés », « Zone Ventes : 6 connaissances »), dix fois au plus.
   Si tu ne trouves aucune trace claire de l'entreprise, n'invente rien et n'envoie pas de proposition : signale error (« Aucune trace de l'entreprise sur ce poste »), dis-le-moi et arrête-toi.
2. Retiens ce qu'un nouvel arrivant doit savoir : ce que fait l'entreprise et pour qui, équipes, clients et partenaires, outils, objectifs, procédures, décisions (avec leur raison). Jamais de secrets, de données personnelles (emails, téléphones, adresses) ni rien de privé.
3. Écris ~/.company-brain/onboarding.json :
   {"source": "claude-code" ou "codex", "company_name": "…", "description": "2 ou 3 phrases", "zones": [{"id": "…", "name": "…", "description": "…", "keywords": ["…"]}], "items": [{"zone": "<id>", "kind": "${KNOWLEDGE_KINDS.join(" | ")}", "title": "…", "body": "…", "entities": [{"type": "${ENTITY_TYPES.join(" | ")}", "name": "…"}]}]}
   3 à 8 zones (actuelles : ${zones} ; garde leurs ids si elles conviennent), 10 à 40 connaissances autonomes et factuelles.
4. Envoie une première version dès que tu tiens les zones et quelques connaissances, sans attendre la fin :
   curl -fsS -X POST ${baseUrl}/api/onboarding/import ${auth} --data @"$HOME/.company-brain/onboarding.json"
   Puis reviens sur ta création : continue à lire, complète le fichier et renvoie-le (chaque envoi remplace le précédent, la page se met à jour).
5. À la fin, signale done (« Terminé : 5 zones, 24 connaissances »), supprime le fichier et dis-moi combien de zones et de connaissances sont parties. Rien n'est appliqué : je relis et valide la proposition à l'écran. En cas d'échec, signale error avec la raison.`
}

