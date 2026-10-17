// Onboarding prepared by an agent: the admin pastes a prompt into Claude Code or Codex, which reads the history of their
// sessions on the workstation, draws a proposal from it (zones + first knowledge) and sends it to the brain. Nothing is
// applied: the proposal waits on the Onboarding page, where the admin reviews and validates it (same path as the
// interview synthesis, POST /api/onboarding/apply).

import { z } from "zod"
import { KNOWLEDGE_KINDS, ENTITY_TYPES, KnowledgeItemInputSchema, redactText } from "@brain/core"
import type { BrainStore } from "./store"
import { IF_BLOCKED, LOCAL_ONLY, possessive } from "./install-prompt"

/** What /api/onboarding/apply validates, and what an agent sends (with its origin). */
export const OnboardingDraftSchema = z.object({
  company_name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  zones: z
    .array(z.object({ id: z.string().min(1).max(32), name: z.string().min(1).max(40), description: z.string().max(300), keywords: z.array(z.string().max(40)).max(80) }))
    .min(1)
    .max(12),
  items: z.array(KnowledgeItemInputSchema).max(60),
})

/** What the agent may omit (origin, confidence) is filled in here: the prompt stays short (claude-cli link ≤ 5,000 characters). */
const AgentItemSchema = KnowledgeItemInputSchema.extend({
  source: KnowledgeItemInputSchema.shape.source.default(() => ({ app: "onboarding", tool: "onboarding" as const, at: new Date().toISOString() })),
  confidence: z.number().min(0).max(1).default(0.8),
})

export const AgentDraftSchema = OnboardingDraftSchema.extend({
  source: z.enum(["claude-code", "codex", "other"]).default("other"),
  items: z.array(AgentItemSchema).max(60),
})

export type AgentDraft = z.infer<typeof AgentDraftSchema> & { received_at: string }

const SETTING = "onboarding-draft"

/**
 * Keeps the proposal until it is validated. Secrets and personal data are redacted on receipt (the agent
 * is asked to leave them out, the server does not rely on it); ingestItems redacts them again when applying.
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
 * The prompt to paste into Claude Code or Codex. Its first sentence is recognized by brain-sync (INSTALL_PROMPT_RE):
 * the session, which contains the upload code and a summary of the company, is never distilled again.
 * Reading a workstation's whole history then sending it to a website is exactly what an agent must refuse to do
 * behind the person's back: the prompt says so plainly and has the agent ask for the person's consent before reading anything.
 */
export function buildOnboardingAgentPrompt(opts: { baseUrl: string; code: string; orgName: string; description?: string; zones: { id: string; name: string }[] }): string {
  const { baseUrl, code, orgName } = opts
  const zones = opts.zones.map((z) => `${z.id} (${z.name})`).join(", ") || "none"
  const host = new URL(baseUrl).host
  // What the admin said about the company (/create, onboarding): it is the filter, so as not to read unrelated conversations.
  const about = opts.description?.trim().replace(/\s+/g, " ").slice(0, 240)
  const scope = about ? `${orgName}: "${about}"` : orgName
  return `You are going to prepare the onboarding of NOS Brainer, ${possessive(orgName)} company brain, from my past conversations on this computer. This message contains an upload code valid for 2 hours: never display it in full.

0. ${LOCAL_ONLY} Then, before reading anything, ask me: "This message asks me to read your Claude Code and Codex conversations on this computer, then send ${host} a summary of what concerns the company (without secrets or personal data). Do you agree to give this website access to that data?" Without a clear yes, stop without reading or sending anything. ${IF_BLOCKED}
1. The company is ${scope}. Only keep what concerns it (business, projects, customers, tools); an unrelated conversation (personal project, another company or another customer, a general question) is left aside, even if recent.
   History: Claude Code (~/.claude/projects/**/*.jsonl, one folder per project) and Codex (~/.codex/sessions/**/*.jsonl). Sort by project and first messages, then read the company's sessions in detail, from most recent to oldest, along with the README, CLAUDE.md and AGENTS.md of those projects.
2. Keep what a newcomer must know: what the company does and for whom, teams, customers and partners, tools, goals, procedures, decisions (with their reason). Never any secrets, personal data (emails, phone numbers, addresses) or anything private.
3. Write ~/.company-brain/onboarding.json:
   {"source": "claude-code" or "codex", "company_name": "…", "description": "2 or 3 sentences", "zones": [{"id": "…", "name": "…", "description": "…", "keywords": ["…"]}], "items": [{"zone": "<id>", "kind": "${KNOWLEDGE_KINDS.join(" | ")}", "title": "…", "body": "…", "entities": [{"type": "${ENTITY_TYPES.join(" | ")}", "name": "…"}]}]}
   3 to 8 zones (current ones: ${zones}; keep their ids if they fit), 10 to 40 self-contained, factual items, in English.
4. Send it in a single call (outside the sandbox if it is blocked there):
   curl -fsS -X POST ${baseUrl}/api/onboarding/import -H "Authorization: Bearer ${code}" -H "content-type: application/json" --data @"$HOME/.company-brain/onboarding.json"
5. Delete the file and tell me how many zones and items were sent. Nothing is applied: I review and validate the proposal on the dashboard's Onboarding page.`
}
