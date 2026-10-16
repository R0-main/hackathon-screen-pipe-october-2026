// Mise en forme (markdown, en français) des réponses du cerveau pour les outils MCP.

import type { ApiItem, ApiZone, CompanyStatusResult, QueryResult, WhoAmI, ZoneSummary } from "./api"

const KIND_LABELS: Record<string, string> = { fact: "fait", decision: "décision", task: "tâche", procedure: "procédure", question: "question" }

export type ZoneNamer = (id: string) => string

export function frDate(iso: string | undefined): string {
  if (!iso) return "?"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Paris" })
}

function itemBlock(i: ApiItem, n: number, zoneName: ZoneNamer): string {
  const meta = [
    `Zone : ${zoneName(i.zone)}`,
    `Type : ${KIND_LABELS[i.kind] ?? i.kind}`,
    `Par : ${i.author ?? "?"}`,
    `Date : ${frDate(i.source?.at ?? i.created_at)}`,
    i.source?.tool ? `Source : ${i.source.tool}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const ents = i.entities?.length ? `\nEntités : ${i.entities.map((e) => e.name).join(", ")}` : ""
  return `### ${n}. ${i.title}\n${meta}\n\n${i.body.trim()}${ents}`
}

export function formatQuery(r: QueryResult, zoneName: ZoneNamer): string {
  const searched = r.zones_searched.length ? r.zones_searched.map(zoneName).join(", ") : "aucune"
  const restricted = r.zones_restricted?.length
    ? "\n\nNote : des zones auxquelles vous n'avez pas accès pourraient en savoir plus (demandez à un admin ou à la personne concernée)."
    : ""
  if (!r.items.length) {
    return (
      `Aucune connaissance trouvée dans le cerveau pour « ${r.query} » (zones consultées : ${searched}).\n` +
      `Essayez d'autres mots-clés (nom de client, d'outil, de projet) ou list_zones pour voir les domaines disponibles.${restricted}`
    )
  }
  const head = `## Cerveau d'entreprise — « ${r.query} »\n${r.items.length} résultat${r.items.length > 1 ? "s" : ""} (zones consultées : ${searched})`
  return `${head}\n\n${r.items.map((i, n) => itemBlock(i, n + 1, zoneName)).join("\n\n---\n\n")}${restricted}`
}

export function formatZones(zones: ApiZone[]): string {
  const lines = zones
    .sort((a, b) => a.position - b.position)
    .map((z) => `- **${z.name}** (\`${z.id}\`) : ${z.description}${z.readable ? ` — accessible, ${z.count ?? 0} connaissance${(z.count ?? 0) > 1 ? "s" : ""}` : " — non accessible"}`)
  return `## Zones du cerveau\n${lines.join("\n")}\n\nUtilisez l'identifiant entre backticks avec get_zone_summary ou dans le filtre zones de search_brain.`
}

export function formatZoneSummary(s: ZoneSummary): string {
  const parts = [`## Zone ${s.zone.name} (\`${s.zone.id}\`)`, s.zone.description]
  if (s.status) {
    parts.push(`### État\n${s.status.summary}\nAvancement : ${s.status.progress}`)
    if (s.status.objectives.length) parts.push(`Objectifs :\n${s.status.objectives.map((o) => `- ${o}`).join("\n")}`)
    if (s.status.next_steps.length) parts.push(`Prochaines étapes :\n${s.status.next_steps.map((o) => `- ${o}`).join("\n")}`)
    if (s.status.who_did_what.length) parts.push(`Qui a fait quoi :\n${s.status.who_did_what.map((w) => `- ${w.person} : ${w.did}`).join("\n")}`)
  }
  const recent = s.items.slice(0, 12)
  parts.push(
    recent.length
      ? `### Connaissances récentes\n${recent.map((i) => `- [${KIND_LABELS[i.kind] ?? i.kind}] ${i.title} — ${i.author ?? "?"}, ${frDate(i.source?.at ?? i.created_at)}`).join("\n")}`
      : "### Connaissances récentes\n(aucune pour l'instant)",
  )
  const open = s.tasks.filter((t) => t.status !== "done").slice(0, 10)
  if (open.length) parts.push(`### Tâches ouvertes\n${open.map((t) => `- ${t.title}${t.assignee ? ` (${t.assignee})` : ""}`).join("\n")}`)
  if (s.entities.length) parts.push(`### Entités les plus citées\n${s.entities.slice(0, 12).map((e) => `${e.name} (${e.type}, ${e.count})`).join(", ")}`)
  return parts.join("\n\n")
}

export function formatWhoami(w: WhoAmI, zoneName: ZoneNamer): string {
  const p = w.profile
  const parts = [
    `## ${p.name}${p.title ? ` — ${p.title}` : ""} (${w.org.name})`,
    `Rôle : ${p.role === "admin" ? "admin" : "membre"} · Zones lisibles : ${w.access.readable.map(zoneName).join(", ") || "aucune"} · Zones en écriture : ${w.access.writable.map(zoneName).join(", ") || "aucune"}`,
  ]
  const c = w.context
  if (c) {
    if (c.zones.length) parts.push(`### Zones les plus utilisées par ce poste\n${c.zones.slice(0, 6).map((z) => `- ${zoneName(z.zone)} (poids ${z.weight})`).join("\n")}`)
    if (c.entities.length) parts.push(`### Entités principales\n${c.entities.slice(0, 12).map((e) => `${e.name} (${e.type}, ${e.count})`).join(", ")}`)
    const prompts = dedupePrompts(c.frequent_prompts)
    if (prompts.length) parts.push(`### Prompts fréquents\n${prompts.map((f) => `- « ${f.summary} » (${f.count} fois, dernier le ${frDate(f.last)})`).join("\n")}`)
    if (c.decisions.length) parts.push(`### Décisions récentes\n${c.decisions.slice(0, 8).map((i) => `- ${i.title} (${zoneName(i.zone)}, ${frDate(i.created_at)})`).join("\n")}`)
    if (c.procedures.length) parts.push(`### Procédures\n${c.procedures.slice(0, 8).map((i) => `- ${i.title} (${zoneName(i.zone)})`).join("\n")}`)
    parts.push("Utile pour une passation : search_brain permet ensuite d'ouvrir le détail de chaque sujet.")
  }
  return parts.join("\n\n")
}

function dedupePrompts(list: { summary: string; count: number; last: string }[]) {
  const seen = new Map<string, { summary: string; count: number; last: string }>()
  for (const f of list) {
    const k = f.summary.trim().toLowerCase()
    const prev = seen.get(k)
    if (!prev) seen.set(k, { ...f })
    else {
      prev.count = Math.max(prev.count, f.count)
      if (f.last > prev.last) prev.last = f.last
    }
  }
  return [...seen.values()].slice(0, 8)
}

export function formatStatus(s: CompanyStatusResult, zoneName: ZoneNamer): string {
  if (!s || !s.headline) return "L'état de l'entreprise n'a pas encore été généré (un admin peut le rafraîchir depuis le dashboard)."
  const zones = (s.zones ?? []).map((z) => {
    const lines = [`### ${zoneName(z.zone)}`, z.summary, `Avancement : ${z.progress}`]
    if (z.objectives.length) lines.push(`Objectifs : ${z.objectives.join(" ; ")}`)
    if (z.next_steps.length) lines.push(`Prochaines étapes : ${z.next_steps.join(" ; ")}`)
    if (z.who_did_what.length) lines.push(`Qui a fait quoi : ${z.who_did_what.map((w) => `${w.person} — ${w.did}`).join(" ; ")}`)
    return lines.join("\n")
  })
  return `## Où en est la boîte ?\n${s.headline}\n\n${zones.join("\n\n")}\n\n(généré le ${frDate(s.generated_at)}, ${s.generator === "claude" ? "par Claude" : "automatiquement"})`
}
