// Onboarding préparé par un agent : l'admin colle un prompt dans Claude Code ou Codex, qui lit l'historique de ses
// sessions sur le poste, en tire une proposition (zones + premières connaissances) et l'envoie au cerveau. Rien n'est
// appliqué : la proposition attend dans la page Onboarding, où l'admin la relit et la valide (même chemin que la
// synthèse de l'interview, POST /api/onboarding/apply).

import { z } from "zod"
import { KNOWLEDGE_KINDS, ENTITY_TYPES, KnowledgeItemInputSchema, redactText } from "@brain/core"
import type { BrainStore } from "./store"
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
  // Ce que l'admin a dit de l'entreprise (/creer, onboarding) : c'est le filtre, pour ne pas lire des conversations sans rapport.
  const about = opts.description?.trim().replace(/\s+/g, " ").slice(0, 240)
  const scope = about ? `${orgName} : « ${about} »` : orgName
  return `Tu vas préparer l'onboarding de NOS Brainer, le cerveau d'entreprise ${org}, à partir de mes anciennes conversations sur ce poste. Ce message contient un code d'envoi valable 2 heures : ne l'affiche jamais en entier.

0. ${LOCAL_ONLY} Puis, avant de lire quoi que ce soit, demande-moi : « Ce message me demande de lire tes conversations Claude Code et Codex de ce poste, puis d'envoyer à ${host} un résumé de ce qui concerne l'entreprise (sans secrets ni données personnelles). Acceptes-tu de donner accès à ces données à ce site ? » Sans un oui clair, arrête-toi sans rien lire ni envoyer. ${IF_BLOCKED}
1. L'entreprise, c'est ${scope}. Ne garde que ce qui la concerne (activité, projets, clients, outils) ; une conversation sans rapport (projet perso, autre entreprise ou autre client, question générale) se laisse de côté, même récente.
   Historique : Claude Code (~/.claude/projects/**/*.jsonl, un dossier par projet) et Codex (~/.codex/sessions/**/*.jsonl). Trie par projet et premiers messages, puis lis en détail les sessions de l'entreprise, des plus récentes aux plus anciennes, avec les README, CLAUDE.md et AGENTS.md de ces projets.
2. Retiens ce qu'un nouvel arrivant doit savoir : ce que fait l'entreprise et pour qui, équipes, clients et partenaires, outils, objectifs, procédures, décisions (avec leur raison). Jamais de secrets, de données personnelles (emails, téléphones, adresses) ni rien de privé.
3. Écris ~/.company-brain/onboarding.json :
   {"source": "claude-code" ou "codex", "company_name": "…", "description": "2 ou 3 phrases", "zones": [{"id": "…", "name": "…", "description": "…", "keywords": ["…"]}], "items": [{"zone": "<id>", "kind": "${KNOWLEDGE_KINDS.join(" | ")}", "title": "…", "body": "…", "entities": [{"type": "${ENTITY_TYPES.join(" | ")}", "name": "…"}]}]}
   3 à 8 zones (actuelles : ${zones} ; garde leurs ids si elles conviennent), 10 à 40 connaissances autonomes et factuelles.
4. Envoie-le en un seul appel (hors du bac à sable s'il y est bloqué) :
   curl -fsS -X POST ${baseUrl}/api/onboarding/import -H "Authorization: Bearer ${code}" -H "content-type: application/json" --data @"$HOME/.company-brain/onboarding.json"
5. Supprime le fichier et dis-moi combien de zones et de connaissances sont parties. Rien n'est appliqué : je relis et valide la proposition dans la page Onboarding du dashboard.`
}
