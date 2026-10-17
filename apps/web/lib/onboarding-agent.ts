// Onboarding préparé par un agent : l'admin colle un prompt dans Claude Code ou Codex, qui lit l'historique de ses
// sessions sur le poste, en tire une proposition (zones + premières connaissances) et l'envoie au cerveau. Rien n'est
// appliqué : la proposition attend dans la page Onboarding, où l'admin la relit et la valide (même chemin que la
// synthèse de l'interview, POST /api/onboarding/apply).

import { z } from "zod"
import { KNOWLEDGE_KINDS, ENTITY_TYPES, KnowledgeItemInputSchema, redactText } from "@brain/core"
import type { BrainStore } from "./store"
import { deNom } from "./install-prompt"

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

export const AgentDraftSchema = OnboardingDraftSchema.extend({ source: z.enum(["claude-code", "codex", "autre"]).default("autre") })

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
 */
export function buildOnboardingAgentPrompt(opts: { baseUrl: string; code: string; orgName: string; zones: { id: string; name: string }[] }): string {
  const { baseUrl, code, orgName } = opts
  const org = deNom(orgName)
  const zones = opts.zones.map((z) => `${z.id} (${z.name})`).join(", ") || "aucune"
  return `Tu vas préparer l'onboarding de NOS Brainer, le cerveau d'entreprise ${org}, à partir de mes anciennes conversations sur ce poste. Ce message contient un code d'envoi valable 2 heures : ne l'affiche jamais en entier.

1. Lis l'historique de mes sessions : Claude Code (~/.claude/projects/**/*.jsonl) et Codex (~/.codex/sessions/**/*.jsonl), plus les README, CLAUDE.md et AGENTS.md des projets qu'elles touchent. Commence par les plus récentes ; cherche ce qui décrit l'entreprise, pas le détail du code.
2. Retiens ce qu'un nouvel arrivant doit savoir : ce que fait l'entreprise et pour qui, ses équipes et métiers, clients et partenaires, outils, objectifs, procédures, décisions prises (avec leur raison). Jamais de secrets (clés, jetons, mots de passe), de données personnelles (emails, téléphones, adresses) ni rien de privé ou sans rapport avec le travail.
3. Écris ~/.company-brain/onboarding.json, au format :
   {"source": "claude-code" ou "codex", "company_name": "…", "description": "2 ou 3 phrases", "zones": [{"id": "dev", "name": "Dev", "description": "…", "keywords": ["…"]}], "items": [{"zone": "<id de zone>", "kind": "${KNOWLEDGE_KINDS.join(" | ")}", "title": "…", "body": "…", "entities": [{"type": "${ENTITY_TYPES.join(" | ")}", "name": "…"}], "source": {"app": "onboarding", "tool": "onboarding"}, "confidence": 0.8}]}
   3 à 8 zones (zones actuelles : ${zones} ; garde leurs ids quand elles conviennent), 10 à 40 connaissances autonomes et factuelles, 60 au plus.
4. Envoie-le en un seul appel (hors du bac à sable s'il est bloqué) :
   curl -fsS -X POST ${baseUrl}/api/onboarding/import -H "Authorization: Bearer ${code}" -H "content-type: application/json" --data @"$HOME/.company-brain/onboarding.json"
5. Supprime le fichier, puis dis-moi en deux lignes combien de zones et de connaissances sont parties. Rien n'est appliqué tout de suite : la proposition s'affiche dans la page Onboarding du dashboard, où je la relis et la valide.`
}
