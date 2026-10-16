// Onboarding de l'entreprise : interview guidée + liens → première version du cerveau.

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
  { id: "activite", question: "Que fait l'entreprise, pour qui, et quel est son modèle économique ?" },
  { id: "equipes", question: "Quelles sont les équipes ou les grands domaines (ex. dev, produit, sales, compta) et qui y travaille ?" },
  { id: "clients", question: "Qui sont vos clients ou partenaires clés en ce moment ?" },
  { id: "outils", question: "Quels outils utilisez-vous au quotidien (code, compta, CRM, docs, to-do…) ?" },
  { id: "objectifs", question: "Quels sont les objectifs des 3 prochains mois ?" },
  { id: "process", question: "Quelles procédures ou habitudes un nouvel arrivant doit-il connaître absolument ?" },
  { id: "liens", question: "Des liens utiles à lire (site, documentation publique, page Notion publique…) ? Un par ligne." },
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

/** Repli sans Claude : zones par mots-clés, une connaissance par réponse / par objectif / par page. */
function heuristicDraft(answers: OnboardingAnswers, pages: ScrapedPage[], existing: Zone[]): OnboardingDraft {
  const zonesById = new Map<string, Omit<Zone, "position" | "color">>()
  // « dev (Hugo, Inès), compta (Jean-Marc) » : les noms entre parenthèses ne sont pas des équipes.
  const teamText = (answers.equipes ?? "").replace(/\([^)]*\)/g, " ")
  for (const part of teamText.split(/[,;\n]| et /)) {
    const p = part.trim()
    if (p.length < 2) continue
    const match = classifyZones(p, existing.length ? existing : DEFAULT_ZONES, 1)[0]
    const template = (existing.length ? existing : DEFAULT_ZONES).find((z) => z.id === match)
    if (template) zonesById.set(template.id, template)
    else {
      const name = firstSentence(p, 30)
      const id = slugify(name)
      zonesById.set(id, { id, name, description: `Connaissances de l'équipe ${name}.`, keywords: tokenize(p).slice(0, 15) })
    }
  }
  if (!zonesById.has("direction")) zonesById.set("direction", DEFAULT_ZONES.find((z) => z.id === "direction")!)
  if (zonesById.size < 3) for (const z of DEFAULT_ZONES.slice(0, 4)) zonesById.set(z.id, z)
  const zones = [...zonesById.values()]
  const hints = zones.map((z) => ({ ...z }))

  const at = new Date().toISOString()
  const source = { app: "dashboard", tool: "onboarding" as const, at }
  const items: KnowledgeItemInput[] = []
  const add = (zone: string | undefined, kind: KnowledgeItemInput["kind"], title: string, body: string) => {
    const z = zone && zones.some((x) => x.id === zone) ? zone : (classifyZones(`${title} ${body}`, hints, 1)[0] ?? "direction")
    items.push({ zone: z, kind, title: truncate(title, 140), body: truncate(body, 1500), entities: extractEntities(body), source, confidence: 0.7 })
  }
  if (answers.activite) add("direction", "fact", firstSentence(answers.activite, 120), answers.activite)
  if (answers.clients) for (const c of splitList(answers.clients).slice(0, 6)) add("sales", "fact", `Client / partenaire clé : ${firstSentence(c, 90)}`, c)
  if (answers.outils) add(undefined, "fact", "Outils utilisés au quotidien", answers.outils)
  if (answers.objectifs)
    for (const o of splitList(answers.objectifs).slice(0, 6)) add(classifyZones(o, hints, 1)[0] ?? "direction", "fact", `Objectif : ${firstSentence(o, 110)}`, o)
  if (answers.process) for (const p of splitList(answers.process).slice(0, 6)) add(undefined, "procedure", firstSentence(p, 120), p)
  for (const page of pages.filter((p) => p.text)) {
    add(undefined, "fact", `${page.title || page.url} — ce qu'il faut en retenir`, `${truncate(page.text, 900)}\n\nSource : ${page.url}`)
  }

  return {
    company_name: firstSentence(answers.activite ?? "Mon entreprise", 40).split(/\s(est|fait|propose|édite|développe)\s/)[0] || "Mon entreprise",
    description: truncate(answers.activite ?? "", 400),
    zones: zones.map((z) => ({ id: z.id, name: z.name, description: z.description, keywords: z.keywords })),
    items,
  }
}

export async function draftOnboarding(answers: OnboardingAnswers, existing: Zone[]): Promise<OnboardingResult> {
  const links = extractLinks(`${answers.liens ?? ""}\n${answers.activite ?? ""}`)
  const pages = await Promise.all(links.map(scrapeUrl))
  const claude = getClaude()
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

/** Palette des zones, dans l'ordre de zoneColor() (qui boucle dessus). */
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
 * Zones à enregistrer pour un brouillon validé. Une zone déjà présente garde sa couleur et sa position ; une nouvelle
 * zone prend une position après toutes les existantes et la première couleur de la palette encore libre (sinon,
 * deux néons identiques et deux zones à la même position, ordonnées différemment selon le stockage).
 * Les zones en double dans le brouillon (même identifiant) ne comptent qu'une fois.
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
