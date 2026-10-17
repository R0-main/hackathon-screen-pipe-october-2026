// Onboarding prepared by an agent: the admin pastes a prompt into Claude Code or Codex, which reads the history of their
// sessions on the workstation, draws a proposal from it (zones + first knowledge) and sends it to the brain. Nothing is
// applied: the proposal waits on the Onboarding page, where the admin reviews and validates it (same path as the
// interview synthesis, POST /api/onboarding/apply).

import { z } from "zod"
import { KNOWLEDGE_KINDS, ENTITY_TYPES, KnowledgeItemInputSchema, redactText } from "@brain/core"
import { verifyOnboardingCode } from "./auth"
import { getRootStore, storeForOrg, type BrainStore } from "./store"
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

/** The company of the admin who requested the upload code (Bearer co_…), or null: invalid or expired code, or no longer admin. */
export async function storeForOnboardingCode(req: Request): Promise<BrainStore | null> {
  const code = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  const userId = await verifyOnboardingCode(code)
  const orgId = userId ? await getRootStore().findUserOrg({ id: userId }) : null
  const store = orgId ? storeForOrg(orgId) : null
  const admin = store && userId ? await store.getProfile(userId) : null
  return admin?.role === "admin" ? store : null
}

/**
 * The agent's feed while it works: it reports its start (right after consent), its findings and its end. The server
 * adds "draft" for each proposal received. The page derives its state from it ("it's started, you can move on") and
 * its notifications; the person does not have to wait on the step.
 */
export const AGENT_STEPS = ["start", "progress", "draft", "done", "error"] as const
export type AgentStep = (typeof AGENT_STEPS)[number]
export const AgentProgressSchema = z.object({
  step: z.enum(["start", "progress", "done", "error"]).default("progress"),
  message: z.string().trim().min(1).max(200),
})
export type AgentEvent = { id: number; step: AgentStep; message: string; at: string }

const PROGRESS = "onboarding-progress"
/** Enough for a full run; beyond that, the oldest drop off. */
const MAX_EVENTS = 40
/** Like the upload code: an older feed comes from another run. */
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

/** Redacted like the proposal: the agent is asked to quote neither secrets nor people, the server does not rely on it. */
export async function addAgentProgress(store: BrainStore, ev: { step: AgentStep; message: string }): Promise<AgentEvent> {
  const events = await loadAgentProgress(store)
  // Increasing even after a clear: the page spots the new ones by their id.
  const event: AgentEvent = { id: Math.max((events.at(-1)?.id ?? 0) + 1, Date.now()), step: ev.step, message: redactText(ev.message).slice(0, 200), at: new Date().toISOString() }
  await store.setOrgSetting(PROGRESS, JSON.stringify([...events, event].slice(-MAX_EVENTS)))
  return event
}

export function clearAgentProgress(store: BrainStore) {
  return store.setOrgSetting(PROGRESS, null)
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
  // The name and what the admin said about the company (/create, onboarding): it is the reading's only filter, so as to
  // learn nothing from an unrelated conversation (personal project, another company, another customer).
  const about = opts.description?.trim().replace(/\s+/g, " ").slice(0, 400)
  const scope = about ? `the company "${orgName}", which describes itself as: "${about}"` : `the company "${orgName}"`
  const auth = `-H "Authorization: Bearer ${code}" -H "content-type: application/json"`
  return `You are going to prepare the onboarding of NOS Brainer, ${possessive(orgName)} company brain, from my past conversations on this computer. This message contains an upload code valid for 2 hours: never display it in full.

0. ${LOCAL_ONLY} Then, before reading anything, ask me: "This message asks me to read your Claude Code and Codex conversations on this computer, then send ${host} a summary of what concerns the company (without secrets or personal data). Do you agree to give this website access to that data?" Without a clear yes, stop without reading or sending anything. ${IF_BLOCKED}
   Keep the page posted: "report" = the curl command of step 4, same headers, but to ${baseUrl}/api/onboarding/progress, with -d '{"step":"…","message":"…"}' instead of --data @… (step start, progress, done or error; a short sentence, without secrets or people's names; outside the sandbox if blocked).
   As soon as I say yes, report start ("Consent received, looking for the company's conversations") and tell me: "It's started: go back to your creation, it fills in as I go."
1. You look ONLY for the projects and conversations of ${scope}. First spot those that match this name and these topics, and learn nothing else: a personal project, another company, another customer, a general question or another subject is not read in detail and does not go into the proposal, even if recent. When in doubt, leave it aside.
   History: Claude Code (~/.claude/projects/**/*.jsonl, one folder per project) and Codex (~/.codex/sessions/**/*.jsonl). Sort by project and first messages, then read the company's sessions in detail, from most recent to oldest, along with the README, CLAUDE.md and AGENTS.md of those projects.
   Report progress at each finding ("3 projects found", "Sales zone: 6 knowledge items"), ten times at most.
   If neither the conversations nor the tools (1b) show a clear trace of the company, make nothing up and send no proposal: report error ("No trace of the company on this computer"), tell me so and stop.
1b. Tools I connect while you read (Notion, Linear…): after the conversations, list them with curl -fsS ${baseUrl}/api/onboarding/tools, then explore each with read-only calls: curl -fsS -X POST ${baseUrl}/api/onboarding/tools/call -d '{"connector":"…","tool":"…","arguments":{}}' (both with the headers of step 4; 25 calls max). They shape the zones and give items ("source": {"app": "<tool>", "tool": "connector"}).
2. Keep what a newcomer must know: what the company does and for whom, teams, customers and partners, tools, goals, procedures, decisions (with their reason). Never any secrets, personal data (emails, phone numbers, addresses) or anything private.
3. Write ~/.company-brain/onboarding.json:
   {"source": "claude-code" or "codex", "company_name": "…", "description": "2 or 3 sentences", "zones": [{"id": "…", "name": "…", "description": "…", "keywords": ["…"]}], "items": [{"zone": "<id>", "kind": "${KNOWLEDGE_KINDS.join(" | ")}", "title": "…", "body": "…", "entities": [{"type": "${ENTITY_TYPES.join(" | ")}", "name": "…"}]}]}
   3 to 8 zones (current ones: ${zones}; keep their ids if they fit), 10 to 40 self-contained, factual items, in English.
4. Send a first version as soon as you have the zones and a few items, without waiting for the end:
   curl -fsS -X POST ${baseUrl}/api/onboarding/import ${auth} --data @"$HOME/.company-brain/onboarding.json"
   Then go back to your creation: keep reading, complete the file and send it again (each upload replaces the previous one, the page updates).
5. Before the end, check the tools again (1b) and send the completed file. Then report done ("Done: 5 zones, 24 knowledge items"), delete the file and tell me how many zones and items were sent. Nothing is applied: I review and validate the proposal on screen. If it fails, report error with the reason.`
}

