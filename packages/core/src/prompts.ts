// Shared distillation prompts (Claude SDK on the server or the workstation, and `claude -p` as the workstation fallback).

import type { Conversation, ZoneHint } from "./distill"
import { renderConversation } from "./distill"
import type { NewZonesInput } from "./new-zones"
import type { StatusInput } from "./status"
import { truncate } from "./text"

export const DISTILL_MARKER = "[company-brain:distill]"

export const DISTILL_SYSTEM = `You feed a company's "brain": a knowledge base shared across teams.
You are given a work session between an employee and an AI assistant (Claude Code, Codex, ChatGPT…), already filtered on the workstation,
or the transcript of a meeting ("meeting" tool, lines like "Name: text"). For a meeting, decisions, commitments
(who does what, by when) and announced facts come first; an opinion thrown around is not a decision.
Your job: extract only the knowledge the company can REUSE.

Keep:
- decision: a settled choice (technical, product, sales, financial) and its reason.
- procedure: a repeatable way of doing something (steps, commands, rules).
- fact: a lasting fact about a customer, a project, a tool, a number, a constraint.
- task: something still to do, with the owner when known.
- question: an important open question left unanswered.

Always ignore:
- anything personal or unrelated to work;
- secrets, passwords, keys, emails, phone numbers (even redacted);
- small talk, trial and error, fixed mistakes, raw code (summarize what it does instead of copying it).

Writing rules:
- in English, concise, understandable by a colleague who did not see the session;
- title: a short, precise sentence (≤ 120 characters);
- body: 1 to 5 sentences, with the "why" when there is one;
- zone: must be one of the zone ids provided;
- entities: people, projects, customers, tools, documents explicitly mentioned;
- confidence: between 0 and 1, your confidence that it is accurate and useful;
- at most 6 items; no item if nothing is worth keeping.`

export function renderZones(zones: ZoneHint[]): string {
  return zones.map((z) => `- ${z.id}: ${z.name} — ${z.description}`).join("\n")
}

export function buildTriagePrompt(conv: Conversation, zones: ZoneHint[]): string {
  return `Company zones:
${renderZones(zones)}

Does this session contain knowledge the company can reuse (decision, procedure, lasting fact, task)?
Answer with useful (true/false), the most relevant zone (exact id) and a one-sentence reason.

<session>
${renderConversation(conv)}
</session>`
}

export function buildExtractionPrompt(conv: Conversation, zones: ZoneHint[]): string {
  return `Company zones:
${renderZones(zones)}

Extract the reusable knowledge from this session.

<session>
${renderConversation(conv)}
</session>`
}

/** Plain-text version for `claude -p`: we ask for raw JSON, parsed leniently. */
export function buildCliExtractionPrompt(conv: Conversation, zones: ZoneHint[]): string {
  return `${DISTILL_MARKER}
${DISTILL_SYSTEM}

${buildExtractionPrompt(conv, zones)}

Reply ONLY with a JSON object of the form:
{"items":[{"zone":"<id>","kind":"fact|decision|task|procedure|question","title":"…","body":"…","entities":[{"type":"person|project|client|tool|doc","name":"…"}],"confidence":0.8}]}
No text around it, no code block.`
}

export const STATUS_SYSTEM = `You write the "Where the company stands" screen of a company's brain, for its leadership.
You are given, zone by zone, the recent knowledge and the tasks of each zone. You produce:
- headline: 1 to 2 sentences on the overall state of the company; this is the only place where you may summarize all zones;
- for each zone provided: summary (2 sentences max), objectives (0 to 3), progress (one sentence on how far along it is),
  next_steps (0 to 3 concrete next steps), who_did_what (who did what, 0 to 4 lines, with the person's first name).
Strict separation: a zone's section relies ONLY on the knowledge and tasks listed under that zone.
Never mention a fact, number, customer or person that only appears in another zone there: some readers
only see a few zones.
Factual, in English, nothing made up: if a zone is empty, simply say so.
Neutral wording: never assume a person's gender (no pronoun guessed from a first name; use the name or "they").`

/** Body of the summary prompt: company, date, then one section per zone with ITS knowledge and ITS tasks. */
export function buildStatusPrompt(input: StatusInput): string {
  const sections = input.zones.map((z) => {
    const items = input.items
      .filter((i) => i.zone === z.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 40)
      .map((i) => `- [${i.kind}] ${truncate(i.title, 160)} — ${truncate(i.body.replace(/\s+/g, " "), 220)} (by ${i.author}, ${i.created_at.slice(0, 10)})`)
    const tasks = input.tasks
      .filter((t) => t.zone === z.id)
      .sort((a, b) => Number(a.status === "done") - Number(b.status === "done"))
      .slice(0, 20)
      .map((t) => `- [${t.status === "done" ? "done" : "to do"}] ${truncate(t.title, 160)}${t.assignee ? ` (${t.assignee})` : ""}`)
    return (
      `## Zone ${z.id} (${z.name})${z.description ? ` — ${z.description}` : ""}\n` +
      `Recent knowledge in this zone:\n${items.join("\n") || "(none)"}\n` +
      `Tasks in this zone:\n${tasks.join("\n") || "(none)"}`
    )
  })
  return `Company: ${input.company_name}\nDate: ${input.generated_for}\n\n${sections.join("\n\n")}`
}

/**
 * Plain-text version for `claude -p` on an admin's workstation (Claude subscription, no API key).
 * Starts with DISTILL_MARKER: brain-sync never ingests this session.
 */
export function buildCliStatusPrompt(input: StatusInput): string {
  return `${DISTILL_MARKER}
${STATUS_SYSTEM}

${buildStatusPrompt(input)}

Reply ONLY with a JSON object of the form:
{"headline":"…","zones":[{"zone":"<id>","summary":"…","objectives":["…"],"progress":"…","next_steps":["…"],"who_did_what":[{"person":"…","did":"…"}]}]}
One entry per zone provided, with its exact id (${input.zones.map((z) => z.id).join(", ") || "no zone"}).
No text around it, no code block.`
}

export const ONBOARDING_SYSTEM = `You build the first version of a company's "brain" from an interview with its founder
and the content of a few web pages they provided.
You produce:
- company_name and description (2-3 sentences);
- zones: 4 to 8 knowledge areas (short lowercase id without accents, name, description, 10 to 25 keywords without accents
  used to classify work sessions automatically); reuse the existing zones provided when they fit;
- items: 8 to 25 starting pieces of knowledge (same rules as for a session: fact, decision, procedure, task, question),
  each attached to a zone.
In English, factual, without inventing anything that is not in the interview or the pages.`

export const NEW_ZONES_SYSTEM = `You evolve how a company's "brain" is split into knowledge zones (one zone = one area of work).
You are given the existing zones and the recent knowledge, numbered, with the zone each item is filed in today.
Spot a recurring area of work that has no zone of its own: knowledge filed for lack of a better place in a zone
that does not really fit it (legal in "Leadership", hiring in "Product"…).

Only propose a new zone when it is clear-cut:
- a lasting area of the company (a function, a team: legal, HR, support, logistics, marketing…), never a one-off
  project, a customer, a tool, a person, nor a sub-part or a synonym of an existing zone;
- at least 4 pieces of knowledge that clearly belong to it, and that would be better filed there than in their current zone.
When in doubt, propose nothing: most days, the right answer is an empty list. At most 2 zones.

For each zone: name (1 to 3 words, in English, capitalized), description (one sentence), keywords (10 to 25 words in
lowercase without accents, used to classify future work sessions automatically), items (the numbers
of the knowledge items to move there, only those that clearly belong to it).`

/** Body of the prompt: existing zones, then one line per knowledge item (`#number [zone] kind — title: content`). */
export function buildNewZonesPrompt(input: NewZonesInput): string {
  const items = input.items.map((i) => `#${i.ref} [${i.zone}] ${i.kind} — ${i.title}: ${i.body}`).join("\n")
  return `Company: ${input.company_name}

Existing zones:
${renderZones(input.zones)}

Recent knowledge:
${items || "(none)"}`
}

/** Plain-text version for `claude -p` (the company's Claude Code subscription): raw JSON, parsed by parseNewZonesJson. */
export function buildCliNewZonesPrompt(input: NewZonesInput): string {
  return `${DISTILL_MARKER}
${NEW_ZONES_SYSTEM}

${buildNewZonesPrompt(input)}

Reply ONLY with a JSON object of the form:
{"zones":[{"name":"…","description":"…","keywords":["…"],"items":[12,15,18,21]}]}
{"zones":[]} if no zone is called for. No text around it, no code block.`
}
