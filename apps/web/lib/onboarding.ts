// Company onboarding: guided interview + links → first version of the brain.

import {
  DEFAULT_ZONES,
  classifyZones,
  extractEntities,
  firstSentence,
  slugify,
  tokenize,
  truncate,
  zoneColor,
  type KnowledgeItemInput,
  type Zone,
} from "@brain/core"
import { synthesizeOnboarding, type OnboardingDraft } from "@brain/core/claude"
import { getClaude } from "./ai"
import { scrapeUrl, type ScrapedPage } from "./scrape"

export const ONBOARDING_QUESTIONS = [
  { id: "activity", question: "What does the company do, for whom, and what is its business model?" },
  { id: "teams", question: "What are the teams or main areas (e.g. dev, product, sales, finance) and who works in them?" },
  { id: "clients", question: "Who are your key customers or partners right now?" },
  { id: "tools", question: "Which tools do you use every day (code, accounting, CRM, docs, to-do…)?" },
  { id: "goals", question: "What are the goals for the next 3 months?" },
  { id: "process", question: "Which procedures or habits must a newcomer absolutely know?" },
  { id: "links", question: "Useful links to read (website, public documentation, public Notion page…)? One per line." },
] as const

export type OnboardingAnswers = Partial<Record<(typeof ONBOARDING_QUESTIONS)[number]["id"], string>>

export type OnboardingResult = OnboardingDraft & { generator: "claude" | "heuristic"; pages: Omit<ScrapedPage, "text">[] }

function extractLinks(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s<>"')]+/g) ?? []).map((u) => u.replace(/[.,;]+$/, "")))].slice(0, 5)
}

function splitList(text: string): string[] {
  return text
    .split(/\n|;|•|(?:^|\s)-\s/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3)
}

/** Fallback without Claude: zones by keywords, one item per answer / per goal / per page. */
function heuristicDraft(answers: OnboardingAnswers, pages: ScrapedPage[], existing: Zone[]): OnboardingDraft {
  const zonesById = new Map<string, Omit<Zone, "position" | "color">>()
  // "dev (Hugo, Inès), finance (Jean-Marc)": the names in parentheses are not teams.
  const teamText = (answers.teams ?? "").replace(/\([^)]*\)/g, " ")
  for (const part of teamText.split(/[,;\n]| and /)) {
    const p = part.trim()
    if (p.length < 2) continue
    const match = classifyZones(p, existing.length ? existing : DEFAULT_ZONES, 1)[0]
    const template = (existing.length ? existing : DEFAULT_ZONES).find((z) => z.id === match)
    if (template) zonesById.set(template.id, template)
    else {
      const name = firstSentence(p, 30)
      const id = slugify(name)
      zonesById.set(id, { id, name, description: `Knowledge of the ${name} team.`, keywords: tokenize(p).slice(0, 15) })
    }
  }
  if (!zonesById.has("leadership")) zonesById.set("leadership", DEFAULT_ZONES.find((z) => z.id === "leadership")!)
  if (zonesById.size < 3) for (const z of DEFAULT_ZONES.slice(0, 4)) zonesById.set(z.id, z)
  const zones = [...zonesById.values()]
  const hints = zones.map((z) => ({ ...z }))

  const at = new Date().toISOString()
  const source = { app: "dashboard", tool: "onboarding" as const, at }
  const items: KnowledgeItemInput[] = []
  const add = (zone: string | undefined, kind: KnowledgeItemInput["kind"], title: string, body: string) => {
    const z = zone && zones.some((x) => x.id === zone) ? zone : (classifyZones(`${title} ${body}`, hints, 1)[0] ?? "leadership")
    items.push({ zone: z, kind, title: truncate(title, 140), body: truncate(body, 1500), entities: extractEntities(body), source, confidence: 0.7 })
  }
  if (answers.activity) add("leadership", "fact", firstSentence(answers.activity, 120), answers.activity)
  if (answers.clients) for (const c of splitList(answers.clients).slice(0, 6)) add("sales", "fact", `Key customer / partner: ${firstSentence(c, 90)}`, c)
  if (answers.tools) add(undefined, "fact", "Tools used every day", answers.tools)
  if (answers.goals)
    for (const o of splitList(answers.goals).slice(0, 6)) add(classifyZones(o, hints, 1)[0] ?? "leadership", "fact", `Goal: ${firstSentence(o, 110)}`, o)
  if (answers.process) for (const p of splitList(answers.process).slice(0, 6)) add(undefined, "procedure", firstSentence(p, 120), p)
  for (const page of pages.filter((p) => p.text)) {
    add(undefined, "fact", `${page.title || page.url} — what to remember`, `${truncate(page.text, 900)}\n\nSource: ${page.url}`)
  }

  return {
    company_name: firstSentence(answers.activity ?? "My company", 40).split(/\s(is|does|makes|offers|builds|develops|sells)\s/)[0] || "My company",
    description: truncate(answers.activity ?? "", 400),
    zones: zones.map((z) => ({ id: z.id, name: z.name, description: z.description, keywords: z.keywords })),
    items,
  }
}

export async function draftOnboarding(answers: OnboardingAnswers, existing: Zone[]): Promise<OnboardingResult> {
  const links = extractLinks(`${answers.links ?? ""}\n${answers.activity ?? ""}`)
  const pages = await Promise.all(links.map((u) => scrapeUrl(u)))
  const claude = await getClaude()
  const qa = ONBOARDING_QUESTIONS.filter((q) => answers[q.id]?.trim()).map((q) => ({ question: q.question, answer: answers[q.id]!.trim() }))
  const draft =
    (claude &&
      (await synthesizeOnboarding(claude, {
        answers: qa,
        pages: pages.filter((p) => p.text).map((p) => ({ url: p.url, title: p.title, text: p.text })),
        existingZones: existing,
      }))) ||
    null
  const pagesMeta = pages.map(({ text: _t, ...rest }) => rest)
  if (draft) return { ...draft, generator: "claude", pages: pagesMeta }
  return { ...heuristicDraft(answers, pages, existing), generator: "heuristic", pages: pagesMeta }
}

/** Zone palette, in zoneColor() order (which loops over it). */
function zonePalette(): string[] {
  const out: string[] = []
  for (let i = 0; i < 64; i++) {
    const c = zoneColor(i).toLowerCase()
    if (out.includes(c)) break
    out.push(c)
  }
  return out
}

/**
 * Zones to save for a validated draft. An existing zone keeps its color and position; a new
 * zone takes a position after all existing ones and the first palette color still free (otherwise,
 * two identical neons and two zones at the same position, ordered differently depending on the store).
 * Duplicate zones in the draft (same id) only count once.
 */
export function zonesFromDraft(draft: Pick<OnboardingDraft, "zones">, existing: Zone[]): Zone[] {
  const palette = zonePalette()
  const usedColors = new Set(existing.map((z) => z.color.toLowerCase()))
  let nextPosition = existing.reduce((m, z) => Math.max(m, z.position), -1) + 1
  const seen = new Set<string>()
  const out: Zone[] = []
  for (const z of draft.zones) {
    if (seen.has(z.id)) continue
    seen.add(z.id)
    const prev = existing.find((e) => e.id === z.id)
    const position = prev ? prev.position : nextPosition++
    const color = prev ? prev.color : (palette.find((c) => !usedColors.has(c)) ?? zoneColor(position))
    usedColors.add(color.toLowerCase())
    out.push({
      id: z.id,
      name: z.name,
      description: z.description,
      keywords: [...new Set([...(prev?.keywords ?? []), ...z.keywords.map((k) => k.toLowerCase())])].slice(0, 60),
      color,
      position,
    })
  }
  return out
}
