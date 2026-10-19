// Heuristic distillation (no LLM): the fallback when no Claude key is available,
// and a safety net in tests. The Claude version lives in claude.ts.
// "Nothing raw": the heuristic only produces templates and short, re-redacted excerpts.

import type { Entity, KnowledgeItemInput, KnowledgeKind, SourceTool, Zone } from "./types"
import { zoneScorer } from "./zones"
import { firstSentence, truncate } from "./text"
import { looksPersonal, redactText } from "./privacy"

export type ConversationMessage = { role: "user" | "assistant"; text: string; at?: string }

/** An AI session rebuilt on the workstation (Claude Code or Codex logs, or a Screenpipe capture). */
export type Conversation = {
  id: string
  tool: SourceTool
  app: string
  title?: string
  cwd?: string
  started_at: string
  ended_at: string
  messages: ConversationMessage[]
  screenpipe_ref?: string
  /** Reminder (short, already redacted) of the initial ask when this segment does not contain it (see chunkConversation). */
  ask?: string
  /**
   * Documents the session worked on (PDF, Word, Excel… read by the agent or dropped in the prompt): absolute paths on
   * the computer, never sent as such. The sync sends the files themselves with the knowledge distilled from the session.
   */
  documents?: string[]
}

export type ZoneHint = Pick<Zone, "id" | "name" | "keywords" | "description" | "projects">

export const KNOWN_TOOLS = [
  "Stripe", "Supabase", "Postgres", "PostgreSQL", "Next.js", "React", "Vue", "Svelte", "Node", "Bun", "Deno", "Python",
  "TypeScript", "Docker", "Kubernetes", "AWS", "GCP", "Azure", "Vercel", "Netlify", "Cloudflare", "GitHub", "GitLab",
  "Linear", "Jira", "Notion", "Slack", "Figma", "HubSpot", "Salesforce", "Pipedrive", "Pennylane", "Qonto", "Stripe",
  "Shopify", "Zapier", "Make", "n8n", "Airtable", "Google Sheets", "Excel", "Todoist", "Intercom", "Zendesk", "Sentry",
  "Datadog", "Redis", "MongoDB", "Prisma", "Drizzle", "Tailwind", "Screenpipe", "Claude", "Claude Code", "Codex", "ChatGPT",
  "OpenAI", "Anthropic", "Mistral", "Brevo", "Sendgrid", "Twilio", "Alan", "Swile", "Payfit", "Lemlist", "Calendly",
]

/** Explicit decisions. Not a bare "decision" ("we'll need a decision"), which PENDING_RE treats as an open question. */
const DECISION_RE =
  /\b(?:we(?:'ve| have)? (?:decided|settled on|chose|picked|opted for|agreed on|went with|are going with)|we(?:'ll| will) (?:use|go with|stick with|keep)|let'?s (?:use|go with|stick with|keep)|i(?:'ve| have)? decided|it was decided|it'?s decided|decided to|decision\s*:|decision made|final(?:ly)? (?:choice|pick)\s*:|(?:chosen|selected|retained|approved) (?:solution|option|approach|vendor|provider|tool|plan|offer|scenario)|(?:solution|option|approach|vendor|provider|tool|plan|offer|scenario) (?:chosen|selected|retained|approved)\b|going with|approved\s*:)/i
/** A hypothesis before the decision verb ("If we keep this pace…", "When we choose…"): not a decision. */
const HYPOTHETICAL_RE =
  /(?:^|[\s,;("])(?:if|whether|when|in case|assuming|suppose|supposing|imagine|maybe|perhaps|unless|should we)(?![a-z])[^.;!?]*$/i

function isDecision(s: string): boolean {
  const m = DECISION_RE.exec(s)
  return Boolean(m) && !HYPOTHETICAL_RE.test(s.slice(0, m?.index ?? 0))
}

/** A decision still to be made: an open question, not a decision. */
const PENDING_RE =
  /\b(?:(?:we(?:'ll| will)?|you(?:'ll| will)?) (?:need|have) to (?:make a )?decid|(?:need|needs) a decision|decision (?:pending|to be made|still open)|still (?:to be )?decided|to be decided|tbd\b|yet to decide)/i
const TASK_RE =
  /^\s*(?:[-*]\s*\[ \]\s*|TODO[:\s]|to ?do\s*:|still to do\s*:?|next steps?\s*:?|action items?\s*:?|we(?:'ll| will) need to\s|remember to\s|don'?t forget to\s)/i
const STEP_RE = /^\s*(\d+)[.)]\s+\S/

function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ")
}

function sentences(text: string): string[] {
  return stripCode(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 400)
}

/** Short re-redacted excerpt: the heuristic never copies more than a few dozen words in a row. */
function excerpt(s: string, max: number): string {
  return truncate(redactText(s.replace(/\s+/g, " ").trim()), max)
}

/**
 * Tool names that are also common words or first names ("Notion of margin", "Slack of 2 days", "Make sure", "Linear growth",
 * "Alan"): exact case, and kept only with a tool cue (see ambiguousToolAt).
 */
const AMBIGUOUS_TOOLS = new Set([
  "Vue", "Node", "Bun", "Deno", "Linear", "Notion", "Slack", "Excel", "Make", "Alan", "Mistral", "Codex", "React", "Drizzle",
  "Tailwind", "Prisma", "Swile", "Sentry", "Claude",
])
/** Tools kept only with a context cue in the text (Alan is also a first name, Make an English verb). */
const TOOL_CONTEXT: Record<string, RegExp> = {
  Alan: /\b(?:health insurance|insurance|healthcare|mutual|benefits)\b/i,
  Make: /\b(?:make\.com|integromat|zapier|n8n|scenario|automation|workflow)\b/i,
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** Every spelling of a known tool, to recognize an enumeration ("Notion and Slack", "Stripe, Notion"). */
const ANY_TOOL_SRC = KNOWN_TOOLS.map(escapeRe).sort((a, b) => b.length - a.length).join("|")
/** Determiners: "the Notion of margin", "a Slack in the schedule" are common nouns, not tools. */
const DETERMINERS = new Set(
  "the a an this that these those my your our their its his her some any no each every which what and or nor".split(" "),
)
/** Preposition + article before the name ("on the Slack of the team", "in the Notion workspace"). */
const PREP_ARTICLE_RE = /(?:^|[^A-Za-z])(?:in|on|with|into|from|via|through|over|to|at)\s+(?:the|our|your|their)\s*$/i
/**
 * Verbs that turn a sentence-initial name into a tool: "Sentry is deployed", "Notion is our wiki". Not "has", "will",
 * "does": "Claude has approved the invoice" talks about a person.
 */
const TOOL_VERBS =
  "is are was were runs crashes sends notifies alerts syncs handles hosts stores lets serves works breaks triggers reports posts chases creates updates imports exports pulls pushes".split(" ")
const TOOL_VERB_AFTER_RE = new RegExp(`^\\s+(?:${TOOL_VERBS.join("|")})\\b`)
/** Lowercase words that may follow a tool: verbs, prepositions, conjunctions ("Vue for the front end", "Make triggers"). */
const TOOL_FOLLOWERS = new Set([
  ...TOOL_VERBS,
  ..."has have will can does did should could would".split(" "),
  ..."and or but for with in on to from into at by via through over under after before during like as than then when if that which who".split(" "),
])
const DETERMINER_AHEAD_RE = /^(?:the|our|your|their|my|his|her|its|this|that|these|those|a|an)(?![a-z])/

/** Tools whose name, capital included, is also an ordinary word at the start of a label ("Make a call", "Linear growth"). */
const LABEL_WORD_TOOLS = new Set(["Make", "Linear"])
/** Tools whose name is also a first name: as the subject of a verb, it is a person first ("Léo and Claude are on leave"). */
const FIRST_NAME_TOOLS = new Set(["Claude", "Alan"])
/** Words after which a first-name tool is the tool: "switch to Alan", "via Claude", "using Claude". */
const TOOL_INTRO_WORDS = new Set("to into via using use uses used in on through switch switched moves moved migrate migrated".split(" "))

/**
 * A common noun follows the tool name, which is then an ordinary word:
 * - "of" without an article ("Notion of margin", "Slack of 2 days"); with an article, it is a complement ("the Slack of the
 *   team" stays a tool);
 * - for Make and Linear, any lowercase word that is neither a verb, a preposition nor a conjunction ("Make sure", "Make a
 *   call", "Linear growth"). Other tools keep their complement ("React components", "Node built-ins", "public Notion page").
 */
function commonNounAfter(tool: string, after: string): boolean {
  const m = /^[^\S\n]{1,3}([a-z][a-z\-]*)/.exec(after)
  if (!m) return false
  if (m[1] === "of") {
    const next = after.slice(m[0].length).trimStart()
    // "the Notion of Fournil", "the Notion space of Fournil": "of" + proper noun is a complement, like "of the team".
    return !DETERMINER_AHEAD_RE.test(next) && !/^[A-Z]/.test(next)
  }
  return LABEL_WORD_TOOLS.has(tool) && !TOOL_FOLLOWERS.has(m[1])
}
/** Header of a tool list: "Recommended tools:", "Stack:", "Integrations". */
const TOOL_HEADER_RE = /\b(?:tools?|stack|software|apps?|applications?|services?|integrations?|platforms?|saas|tech|technolog(?:y|ies))\b/i
const BULLET_RE = /^\s*(?:[-*•·+]|\d+[.)]|[a-z][.)])\s+/
const COORD = String.raw`\s*(?:,|/|\+|&|\band\b|\bor\b)\s*`
const TOOL_THEN_COORD_RE = new RegExp(`(?:^|[^A-Za-z0-9])(?:${ANY_TOOL_SRC})${COORD}$`)
const COORD_THEN_TOOL_RE = new RegExp(`^${COORD}(?:${ANY_TOOL_SRC})(?![A-Za-z0-9])`)
const TOOL_HEAD_RE = new RegExp(`^(?:${ANY_TOOL_SRC})(?![A-Za-z0-9])`, "i")

/**
 * A bullet that starts with a known tool ("- Stripe for payments", "- **Notion**: the docs"); an ambiguous tool only counts
 * with its exact case and when no common noun follows it ("- Make sure: …", "- Linear growth").
 */
function toolBullet(line: string): "plain" | "ambiguous" | null {
  const body = line.replace(BULLET_RE, "").replace(/^[*_`\s]+/, "")
  const head = TOOL_HEAD_RE.exec(body)?.[0]
  if (!head) return null
  const name = KNOWN_TOOLS.find((t) => t.toLowerCase() === head.toLowerCase()) ?? head
  if (!AMBIGUOUS_TOOLS.has(name)) return "plain"
  return head === name && !commonNounAfter(name, body.slice(head.length)) ? "ambiguous" : null
}

type ToolBulletKind = ReturnType<typeof toolBullet>

/**
 * Reading of a text, memoized per line: is it a bullet, what kind of tool does it start with (see toolBullet), and the
 * verdict for each list. A long list of "- Notion" or "- Make sure" lines is not re-read on every occurrence.
 */
type ListMemo = { lines: string[]; bullet: Map<number, boolean>; kind: Map<number, ToolBulletKind>; blocks: Map<number, boolean> }

function isBulletLine(memo: ListMemo, k: number): boolean {
  let v = memo.bullet.get(k)
  if (v === undefined) memo.bullet.set(k, (v = BULLET_RE.test(memo.lines[k])))
  return v
}

/**
 * Tool list without a header (lines `start` to `end`): at least two bullets, each starting with a tool, one of them
 * unambiguous ("- Stripe for payments\n- Notion for the docs"). Only ambiguous names are people or words
 * ("Team:\n- Claude: manager\n- Alan: accountant", "- Node A\n- Node B").
 */
function toolList(memo: ListMemo, start: number, end: number): boolean {
  if (end - start < 1) return false
  let plain = false
  for (let k = start; k <= end; k++) {
    let kind = memo.kind.get(k)
    if (kind === undefined) memo.kind.set(k, (kind = toolBullet(memo.lines[k])))
    if (kind === null) return false
    plain ||= kind === "plain"
  }
  return plain
}

/** Last word of `before` (before trailing whitespace), read from the end: "in the workspace" → "workspace". */
function lastWord(before: string): string {
  let end = before.length
  while (end > 0 && /\s/.test(before[end - 1])) end--
  let start = end
  while (start > 0 && /[A-Za-zÀ-ÿ']/.test(before[start - 1])) start--
  return before.slice(start, end).toLowerCase()
}
/** A longer list is only read over 30 lines around the bullet: bounded cost. */
const BLOCK_SPAN = 30

/** Lines of the bullet list containing line `i` (none if it is not a bullet), and the header right before it. */
function bulletBlock(memo: ListMemo, i: number): { start: number; end: number; header: string } | null {
  if (!isBulletLine(memo, i)) return null
  let a = i
  while (a > 0 && i - a < BLOCK_SPAN && isBulletLine(memo, a - 1)) a--
  let b = i
  while (b + 1 < memo.lines.length && b - i < BLOCK_SPAN && isBulletLine(memo, b + 1)) b++
  let h = a - 1
  while (h >= 0 && a - h < BLOCK_SPAN && !memo.lines[h].trim()) h--
  return { start: a, end: b, header: h >= 0 && !isBulletLine(memo, h) ? memo.lines[h] : "" }
}

/**
 * Is an ambiguous tool name (exact case) at position `at` the tool? Never when a common noun follows it ("Make sure",
 * "Notion of margin", see commonNounAfter). Otherwise it needs a cue:
 * - a version number or an extension ("Vue 3", "Node 22", "vue.js");
 * - mid-sentence, after a word that is not a determiner ("in Notion", "the Excel file", "the Slack API"):
 *   a common noun would take an article ("the notion of margin") and a heading starts with that word ("## Make it fast");
 * - a preposition and an article ("on the Slack");
 * - a verb right after, with no article before ("Sentry is deployed in prod", "Notion is our wiki");
 * - an enumeration with another tool ("Notion and Slack");
 * - a tool list: a "Tools:" / "Stack:" header, or a list where each bullet starts with a tool
 *   ("- Stripe for payments\n- Notion for the docs"); a single "- Qonto: …" bullet is not enough.
 */
function ambiguousToolAt(
  tool: string,
  text: string,
  at: number,
  memo: ListMemo,
  lineIndex: number,
  lineStart: number,
): boolean {
  const after = text.slice(at + tool.length, at + tool.length + 60)
  const before = text.slice(Math.max(lineStart, at - 200), at)
  if (/^\s?\d/.test(after) || /^\.(?:js|com|so|app|io)\b/i.test(after)) return true
  if (commonNounAfter(tool, after)) return false
  // Previous word, on the same line: an ordinary word (not a determiner) ⇒ mid-sentence. A first name needs a word that
  // introduces a tool ("moves to Alan", "via Claude"): after "Ask" or "with", Alan and Claude are people.
  const prevWord = lastWord(before)
  if (prevWord && !DETERMINERS.has(prevWord) && (!FIRST_NAME_TOOLS.has(tool) || TOOL_INTRO_WORDS.has(prevWord))) return true
  if (PREP_ARTICLE_RE.test(before)) return true
  // Subject of a verb ("Sentry is deployed", "The Sentry is deployed", "This Slack is for alerts", "… and Slack sends").
  // Make and Linear are also ordinary words, and Claude and Alan first names: after a determiner, they are not tools.
  if ((!prevWord || !(LABEL_WORD_TOOLS.has(tool) || FIRST_NAME_TOOLS.has(tool))) && TOOL_VERB_AFTER_RE.test(after)) return true
  // Enumeration: "Notion and Slack", "Stripe, Notion", "Slack / Linear".
  if (TOOL_THEN_COORD_RE.test(before.slice(-40)) || COORD_THEN_TOOL_RE.test(after)) return true
  // Tool list (bullets): explicit header, or each bullet starts with a tool.
  if (TOOL_HEADER_RE.test(before)) return true
  const block = bulletBlock(memo, lineIndex)
  if (!block) return false
  // Verdict memoized per line (and shared across tools): a long list of "- Vue" is not re-read on every occurrence.
  let listOfTools = memo.blocks.get(lineIndex)
  if (listOfTools === undefined) {
    listOfTools = TOOL_HEADER_RE.test(block.header) || toolList(memo, block.start, block.end)
    memo.blocks.set(lineIndex, listOfTools)
  }
  return listOfTools
}

/** Reading memo of a text (see ListMemo), created at the first ambiguous tool met and shared by all tools. */
type MemoRef = { memo: ListMemo | null }

function toolMentioned(tool: string, text: string, ref: MemoRef = { memo: null }): boolean {
  const esc = escapeRe(tool)
  if (!AMBIGUOUS_TOOLS.has(tool)) return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, "i").test(text)
  if (new RegExp(`(^|[^A-Za-z0-9])${esc}\\.js\\b`, "i").test(text)) return true
  const context = TOOL_CONTEXT[tool]
  if (context && !context.test(text)) return false
  // Line number kept up to date across (increasing) occurrences: no recount from the start of the text, and the position
  // of the next "\n" is kept from one occurrence to the next (the line is not re-read on every occurrence).
  let lineIndex = 0
  let scanned = 0
  let nextNl = text.indexOf("\n")
  for (const m of text.matchAll(new RegExp(`(^|[^A-Za-z0-9\\-])${esc}(?![A-Za-z0-9\\-'’])`, "g"))) {
    const at = (m.index ?? 0) + m[1].length
    while (nextNl !== -1 && nextNl < at) {
      lineIndex++
      scanned = nextNl + 1
      nextNl = text.indexOf("\n", scanned)
    }
    ref.memo ??= { lines: text.split("\n"), bullet: new Map(), kind: new Map(), blocks: new Map() }
    if (ambiguousToolAt(tool, text, at, ref.memo, lineIndex, scanned)) return true
  }
  return false
}

export function extractEntities(text: string, cwd?: string): Entity[] {
  const found = new Map<string, Entity>()
  const add = (e: Entity) => found.set(`${e.type}:${e.name.toLowerCase()}`, e)
  const ref: MemoRef = { memo: null }
  for (const tool of KNOWN_TOOLS) if (toolMentioned(tool, text, ref)) add({ type: "tool", name: tool })
  if (cwd) {
    const base = cwd.split(/[\\/]/).filter(Boolean).pop()
    if (base && base.length > 1 && !["src", "home", "Users", "user", "tmp", "Desktop"].includes(base)) add({ type: "project", name: base })
  }
  for (const m of text.matchAll(/\b(?:client|customer|for the client|for the customer|prospect)\s+([A-Z][\w&'-]+(?:\s+[A-Z][\w&'-]+){0,2})/g)) {
    add({ type: "client", name: m[1] })
  }
  for (const m of text.matchAll(/\bproject\s+([A-Z][\w-]+(?:\s+[A-Z][\w-]+)?)/g)) add({ type: "project", name: m[1] })
  for (const m of text.matchAll(/@([A-Z][a-zà-ÿ]+(?:\s[A-Z][a-zà-ÿ]+)?)/g)) add({ type: "person", name: m[1] })
  return [...found.values()].slice(0, 8)
}

/** Longest passage copied verbatim from what the employee wrote (ask, messages), in any field sent. */
export const MAX_PROMPT_VERBATIM = 80
/** Longest excerpt taken from an assistant answer. */
const MAX_ANSWER_EXCERPT = 200

/**
 * Session read on screen (Screenpipe) or in a web assistant: OCR mixes the ask typed by the employee and the answer
 * in the "assistant" text. Only Claude Code and Codex logs truly separate what the employee wrote.
 */
export function isScreenCapture(conv: Pick<Conversation, "id" | "tool" | "screenpipe_ref">): boolean {
  return !(conv.tool === "claude-code" || conv.tool === "codex") || conv.id.startsWith("screenpipe:") || Boolean(conv.screenpipe_ref)
}

/** Set of text windows (see verbatimWindows); a Set<string> works too. */
export type VerbatimWindows = { has(window: string): boolean; readonly size: number }

const HASH_MOD = 1_000_000_007
const HASH_BASE = 131

/** Polynomial fingerprint of a window (modulo a prime < 2^30: a small integer, fast as a Map key). */
function windowHash(s: string, from: number, len: number): number {
  let h = 0
  for (let i = from; i < from + len; i++) h = (h * HASH_BASE + s.charCodeAt(i)) % HASH_MOD
  return h
}

/**
 * Windows of `max + 1` characters of the employee's texts (normalized whitespace, already redacted): a longer copied passage
 * shows up in them. Indexed by rolling hash (the position of each window, chained by hash, instead of 320,000 strings of
 * 81 characters); a lookup checks character by character: same answer as a Set of the windows.
 * `size` counts the windows (duplicates included): only "no window" matters.
 */
export function verbatimWindows(texts: string[], max: number): VerbatimWindows {
  const w = max + 1
  // The texts, joined; "\n" (absent from a text with normalized whitespace) separates them, and no window contains it.
  const all = texts.map((t) => redactText(t.replace(/\s+/g, " ").trim())).join("\n")
  const n = Math.max(0, all.length - w + 1)
  let bits = 10
  while (1 << bits < 2 * n) bits++
  const mask = (1 << bits) - 1
  const head = new Int32Array(1 << bits) // hash & mask → last position + 1 (0: empty)
  const next = new Int32Array(n) // position → previous position in the same bucket + 1
  const hashes = new Int32Array(n)
  let size = 0
  let top = 1
  for (let i = 1; i < w; i++) top = (top * HASH_BASE) % HASH_MOD
  let h = 0
  let start = 0 // start of the current text
  for (let i = 0; i < all.length; i++) {
    if (all.charCodeAt(i) === 10) {
      start = i + 1
      h = 0
      continue
    }
    if (i - start >= w) h = (h - ((all.charCodeAt(i - w) * top) % HASH_MOD) + HASH_MOD) % HASH_MOD
    h = (h * HASH_BASE + all.charCodeAt(i)) % HASH_MOD
    if (i - start + 1 < w) continue
    const at = i + 1 - w
    hashes[at] = h
    next[at] = head[h & mask]
    head[h & mask] = at + 1
    size++
  }
  return {
    size,
    has(window: string) {
      if (window.length !== w || size === 0) return false
      const wh = windowHash(window, 0, w)
      for (let p = head[wh & mask]; p !== 0; p = next[p - 1]) if (hashes[p - 1] === wh && all.startsWith(window, p - 1)) return true
      return false
    },
  }
}

/**
 * Shortens any passage of more than `max` characters copied verbatim (final safety net, whatever the template).
 * Comparison is done with normalized whitespace, like the windows: a multi-line field (steps joined by "\n")
 * is seen like the source, where those lines follow each other. The cut is mapped back onto the field, line breaks included.
 */
export function clipVerbatim(field: string, windows: VerbatimWindows, max: number): string {
  const w = max + 1
  if (windows.size === 0 || field.length < w) return field
  // norm: the field with normalized whitespace; at[k]: position in `field` of the k-th character of norm.
  let norm = ""
  const at: number[] = []
  for (let i = 0; i < field.length; i++) {
    const space = /\s/.test(field[i])
    if (space && norm.endsWith(" ")) continue
    norm += space ? " " : field[i]
    at.push(i)
  }
  let out = ""
  let from = 0
  for (let i = 0; i + w <= norm.length; ) {
    if (!windows.has(norm.slice(i, i + w))) {
      i++
      continue
    }
    let end = i + w
    while (end < norm.length && windows.has(norm.slice(end + 1 - w, end + 1))) end++
    const cut = at[i + max - 1]
    const next = end < norm.length ? at[end] : field.length
    // The cut part spans a line end (one step and the next): what follows stays on its own line.
    const rest = field.slice(next)
    out += `${field.slice(from, cut).trimEnd()}…${field.slice(cut, next).includes("\n") ? "\n" : /^\s/.test(rest) ? "" : " "}`
    from = next
    i = end
  }
  // "…because the l… … —": a cut right before the ellipsis of an already shortened excerpt does not add a second one.
  return (out + field.slice(from)).replace(/…(\s*)…/g, (_, s: string) => (s.includes("\n") ? "…\n" : "…")).trim()
}

/**
 * Distills a conversation into knowledge items, without an LLM.
 * Nothing raw: the employee's ask only appears as an excerpt of at most 80 characters (title), never as "context";
 * assistant sentences are short, re-redacted excerpts. A final safety net shortens any passage of more than
 * 80 characters copied from what the employee wrote. For a screen capture (see isScreenCapture), all the captured text
 * counts as written by the employee: no field copies more than 80 characters in a row from the source.
 * Each item's zone is the conversation's, unless there is a clearly stronger cue for another zone.
 */
export function distillHeuristic(conv: Conversation, zones: ZoneHint[], fallbackZone?: string): KnowledgeItemInput[] {
  const userMsgs = conv.messages.filter((m) => m.role === "user" && m.text.trim())
  const asstMsgs = conv.messages.filter((m) => m.role === "assistant" && m.text.trim())
  if (asstMsgs.length === 0) return []

  const all = conv.messages.map((m) => m.text).join("\n")
  // Safety net: applyPrivacy already drops these sessions, but the heuristic is also the fallback when the LLM fails.
  if (looksPersonal(`${conv.title ?? ""}\n${conv.ask ?? ""}\n${all}`)) return []

  // The ask: session title, reminder of the initial ask (trailing segment), or first message.
  const askText = conv.title || conv.ask || userMsgs[0]?.text || ""
  const ask = askText ? excerpt(firstSentence(askText, 200), MAX_PROMPT_VERBATIM) : ""
  // Zone keywords normalized once for the whole distillation (not for each item).
  const score = zoneScorer(zones)
  const askZone = askText ? score(askText)[0]?.zone : undefined
  const zone =
    score(`${conv.title ?? ""}\n${conv.ask ?? ""}\n${all}`, { prefer: [askZone, fallbackZone] })[0]?.zone ??
    fallbackZone ??
    zones[0]?.id ??
    "general"
  // A single line only changes zone on a clear cue (≥ 2 keywords and a 1-point lead), never on a tie.
  const zoneFor = (text: string): string => {
    const scores = score(text, { prefer: [zone] })
    const top = scores[0]
    if (!top || top.zone === zone) return zone
    const own = scores.find((s) => s.zone === zone)?.score ?? 0
    return top.score >= 2 && top.score >= own + 1 ? top.zone : zone
  }

  const entities = extractEntities(all, conv.cwd)
  const project = entities.find((e) => e.type === "project")?.name
  const source = { app: conv.app, tool: conv.tool, at: conv.ended_at, session_id: conv.id, screenpipe_ref: conv.screenpipe_ref }
  const where = project ? `${conv.tool}, project ${project}` : conv.tool
  const screen = isScreenCapture(conv)
  const typed = [conv.title, conv.ask, ...(screen ? conv.messages : userMsgs).map((m) => m.text)].filter((t): t is string => Boolean(t))
  const windows = verbatimWindows(typed, MAX_PROMPT_VERBATIM)
  const clip = (t: string) => clipVerbatim(t, windows, MAX_PROMPT_VERBATIM)
  const usable = (s: string) => !looksPersonal(s)
  const items: KnowledgeItemInput[] = []
  const seen = new Set<string>()
  // An item's zone is read from the excerpt itself, not from the template ("claude-code session" is not a Dev cue).
  const push = (kind: KnowledgeKind, title: string, body: string, confidence: number, zoneText = `${title} ${body}`) => {
    const t = clip(truncate(title, 140))
    const key = `${kind}:${t.toLowerCase()}`
    if (seen.has(key) || t.length < 8) return
    seen.add(key)
    items.push({ zone: zoneFor(zoneText), kind, title: t, body: clip(truncate(body, 1500)), entities, source, confidence })
  }
  // What the employee wrote is only reused as an 80-character excerpt; an assistant sentence, 200 at most.
  const limitFor = (role: ConversationMessage["role"]) => (screen || role === "user" ? MAX_PROMPT_VERBATIM : MAX_ANSWER_EXCERPT)

  // 1. Session summary: the topic + two key sentences from the final answer (separate excerpts, not the raw ask).
  const gist: string[] = []
  for (const s of sentences(asstMsgs[asstMsgs.length - 1].text)) {
    if (gist.length >= 2) break
    if (usable(s)) gist.push(excerpt(s, screen ? MAX_PROMPT_VERBATIM : 160))
  }
  if (ask && gist.length) push("fact", ask, `Outcome (${where}): ${gist.join(" — ")}`, 0.45, `${ask} ${gist.join(" ")}`)

  // Only the first MAX_ITEMS items are kept: beyond that, nothing more is read (nor redacted, classified or checked).
  const full = () => items.length >= MAX_ITEMS

  // 2. Explicit decisions (a question or a hypothesis is not a decision: "how long do we keep it?", "if we keep…").
  for (const m of conv.messages) {
    if (full()) break
    const max = limitFor(m.role)
    for (const s of sentences(m.text)) {
      if (full()) break
      if (s.trimEnd().endsWith("?")) continue
      const pending = PENDING_RE.test(s)
      if ((!pending && !isDecision(s)) || !usable(s)) continue
      if (pending) push("question", excerpt(s, Math.min(max, 140)), `${excerpt(s, max)}\n(Open question, ${where} session)`, 0.5, s)
      else push("decision", excerpt(s, Math.min(max, 140)), `${excerpt(s, max)}\n(Decision, ${where} session)`, 0.6, s)
    }
  }

  // 3. Tasks.
  for (const m of conv.messages) {
    if (full()) break
    const max = limitFor(m.role)
    for (const line of stripCode(m.text).split("\n")) {
      if (full()) break
      if (!TASK_RE.test(line) || PENDING_RE.test(line) || !usable(line)) continue
      const clean = line.replace(TASK_RE, "").replace(/^[-*\s]+/, "").trim()
      if (clean.length >= 8) push("task", excerpt(clean, Math.min(max, 140)), `${excerpt(clean, max)}\n(To do, ${where} session)`, 0.55, clean)
    }
  }

  // 4. Procedures: an answer with at least 3 numbered steps (8 at most, each shortened), see procedureBody.
  for (const m of full() ? [] : asstMsgs) {
    const steps: string[] = []
    for (const l of stripCode(m.text).split("\n")) {
      if (steps.length >= MAX_STEPS) break
      if (STEP_RE.test(l) && usable(l)) steps.push(l.replace(/^\s*\d+[.)]\s+/, ""))
    }
    if (steps.length >= 3) {
      const subject = ask || excerpt(steps[0], screen ? MAX_PROMPT_VERBATIM : 100)
      const title = /^procedure\b/i.test(subject) ? subject : `Procedure: ${subject}`
      const body = procedureBody(steps.map((s) => excerpt(s, screen ? MAX_PROMPT_VERBATIM : 140)))
      push("procedure", title, body, 0.6, `${ask} ${body}`)
      break
    }
  }

  return items.slice(0, MAX_ITEMS)
}

/** Items kept per session, steps kept per procedure. */
const MAX_ITEMS = 6
const MAX_STEPS = 8

/**
 * Body of a procedure, one step per line, numbered "Step N/M: " (the source lost its own "1." number).
 * Neither the source's numbering ("1. …") nor the one an employee often types ("Step 1: …"): the list of steps does not
 * copy a block of the source (captured text, or an ask the assistant repeats), and the safety net only cuts a step that is
 * too long, not the whole procedure. A step that already names itself ("Step 1 of the runbook") is not renumbered.
 */
function procedureBody(steps: string[]): string {
  return steps
    .map((s) => s.replace(STEP_LABEL_RE, "") || s)
    .map((s, i) => (/^step\s?\d/i.test(s) ? s : `Step ${i + 1}/${steps.length}: ${s}`))
    .join("\n")
}
/** Step label already present, bold included: "Step 1: ", "**Step 2:** ", "Step 3. ", "Step 1/5 — ". */
const STEP_LABEL_RE = /^[*_]{0,3}step[ \t]?\d{1,3}(?:\/\d{1,3})?[ \t]?[*_]{0,3}[ \t]?[:.)—–-][ \t]?[*_]{0,3}[ \t]?/i

/** Splits a text that is too long into pieces, preferably at the end of a paragraph, a line or a sentence. */
function splitLong(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const head = rest.slice(0, max)
    let cut = head.lastIndexOf("\n\n")
    if (cut < max / 2) cut = head.lastIndexOf("\n")
    if (cut < max / 2) cut = head.lastIndexOf(". ") + 1
    if (cut < max / 2) cut = max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }
  out.push(rest.trim())
  return out.filter(Boolean)
}

/**
 * Splits a conversation that is too long into segments (whole messages) for distillation.
 * A message that is too long is cut into pieces, not truncated: the end of a long answer often carries the decisions and
 * the tasks. Segments that do not contain the initial ask get a reminder of it (`ask`).
 */
export function chunkConversation(conv: Conversation, maxChars = 24000): Conversation[] {
  const pieces = conv.messages.flatMap((m) => (m.text.length > maxChars ? splitLong(m.text, maxChars).map((text) => ({ ...m, text })) : [m]))
  const groups: ConversationMessage[][] = []
  let current: ConversationMessage[] = []
  let size = 0
  for (const m of pieces) {
    if (size + m.text.length > maxChars && current.length > 0) {
      groups.push(current)
      current = []
      size = 0
    }
    current.push(m)
    size += m.text.length
  }
  if (current.length) groups.push(current)
  if (groups.length <= 1) return groups.map((messages) => ({ ...conv, messages }))
  const first = conv.messages.find((m) => m.role === "user" && m.text.trim())
  const ask = conv.ask ?? (first ? truncate(first.text.replace(/\s+/g, " ").trim(), 300) : undefined)
  return groups.map((messages, i) => {
    const chunk: Conversation = { ...conv, id: `${conv.id}#${i}`, messages }
    if (ask && !(first && messages.includes(first))) chunk.ask = ask
    return chunk
  })
}

/** Renders a conversation readably for an LLM. */
export function renderConversation(conv: Conversation): string {
  const head = [
    `Tool: ${conv.tool} (${conv.app})`,
    conv.cwd ? `Project / folder: ${conv.cwd}` : "",
    `Period: ${conv.started_at} → ${conv.ended_at}`,
    conv.ask ? `Initial ask (reminder, outside this segment): ${conv.ask}` : "",
  ]
    .filter(Boolean)
    .join("\n")
  const meeting = conv.tool === "meeting"
  const label = (role: string) => (meeting ? (role === "user" ? "Meeting transcript" : "Recorded notes") : role === "user" ? "Employee" : "AI assistant")
  const body = conv.messages.map((m) => `### ${label(m.role)}\n${m.text.trim()}`).join("\n\n")
  return `${head}\n\n${body}`
}
