// Formatting (markdown) of the brain's answers for the MCP tools.

import type { ApiItem, ApiZone, CompanyStatusResult, QueryResult, WhoAmI, ZoneSummary } from "./api"

const KIND_LABELS: Record<string, string> = { fact: "fact", decision: "decision", task: "task", procedure: "procedure", question: "question" }

export type ZoneNamer = (id: string) => string

export function shortDate(iso: string | undefined): string {
  if (!iso) return "?"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Europe/Paris" })
}

function itemBlock(i: ApiItem, n: number, zoneName: ZoneNamer): string {
  const meta = [
    `Zone: ${zoneName(i.zone)}`,
    `Type: ${KIND_LABELS[i.kind] ?? i.kind}`,
    `By: ${i.author ?? "?"}`,
    `Date: ${shortDate(i.source?.at ?? i.created_at)}`,
    i.source?.tool ? `Source: ${i.source.tool}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const ents = i.entities?.length ? `\nEntities: ${i.entities.map((e) => e.name).join(", ")}` : ""
  return `### ${n}. ${i.title}\n${meta}\n\n${i.body.trim()}${ents}`
}

export function formatQuery(r: QueryResult, zoneName: ZoneNamer): string {
  const searched = r.zones_searched.length ? r.zones_searched.map(zoneName).join(", ") : "none"
  const restricted = r.zones_restricted?.length
    ? "\n\nNote: zones you do not have access to might know more (ask an admin or the person concerned)."
    : ""
  if (!r.items.length) {
    return (
      `No knowledge found in the brain for "${r.query}" (zones searched: ${searched}).\n` +
      `Try other keywords (customer, tool or project name) or list_zones to see the available areas.${restricted}`
    )
  }
  const head = `## Company brain — "${r.query}"\n${r.items.length} result${r.items.length > 1 ? "s" : ""} (zones searched: ${searched})`
  return `${head}\n\n${r.items.map((i, n) => itemBlock(i, n + 1, zoneName)).join("\n\n---\n\n")}${restricted}`
}

export function formatZones(zones: ApiZone[]): string {
  const lines = zones
    .sort((a, b) => a.position - b.position)
    .map((z) => `- **${z.name}** (\`${z.id}\`): ${z.description}${z.readable ? ` — accessible, ${z.count ?? 0} knowledge item${(z.count ?? 0) === 1 ? "" : "s"}` : " — not accessible"}`)
  return `## Brain zones\n${lines.join("\n")}\n\nUse the id between backticks with get_zone_summary or in the zones filter of search_brain.`
}

export function formatZoneSummary(s: ZoneSummary): string {
  const parts = [`## Zone ${s.zone.name} (\`${s.zone.id}\`)`, s.zone.description]
  if (s.status) {
    parts.push(`### Status\n${s.status.summary}\nProgress: ${s.status.progress}`)
    if (s.status.objectives.length) parts.push(`Goals:\n${s.status.objectives.map((o) => `- ${o}`).join("\n")}`)
    if (s.status.next_steps.length) parts.push(`Next steps:\n${s.status.next_steps.map((o) => `- ${o}`).join("\n")}`)
    if (s.status.who_did_what.length) parts.push(`Who did what:\n${s.status.who_did_what.map((w) => `- ${w.person}: ${w.did}`).join("\n")}`)
  }
  const recent = s.items.slice(0, 12)
  parts.push(
    recent.length
      ? `### Recent knowledge\n${recent.map((i) => `- [${KIND_LABELS[i.kind] ?? i.kind}] ${i.title} — ${i.author ?? "?"}, ${shortDate(i.source?.at ?? i.created_at)}`).join("\n")}`
      : "### Recent knowledge\n(none for now)",
  )
  const open = s.tasks.filter((t) => t.status !== "done").slice(0, 10)
  if (open.length) parts.push(`### Open tasks\n${open.map((t) => `- ${t.title}${t.assignee ? ` (${t.assignee})` : ""}`).join("\n")}`)
  if (s.entities.length) parts.push(`### Most cited entities\n${s.entities.slice(0, 12).map((e) => `${e.name} (${e.type}, ${e.count})`).join(", ")}`)
  return parts.join("\n\n")
}

export function formatWhoami(w: WhoAmI, zoneName: ZoneNamer): string {
  const p = w.profile
  const parts = [
    `## ${p.name}${p.title ? ` — ${p.title}` : ""} (${w.org.name})`,
    `Role: ${p.role === "admin" ? "admin" : "member"} · Readable zones: ${w.access.readable.map(zoneName).join(", ") || "none"} · Writable zones: ${w.access.writable.map(zoneName).join(", ") || "none"}`,
  ]
  const c = w.context
  if (c) {
    if (c.zones.length) parts.push(`### Zones most used by this computer\n${c.zones.slice(0, 6).map((z) => `- ${zoneName(z.zone)} (weight ${z.weight})`).join("\n")}`)
    if (c.entities.length) parts.push(`### Main entities\n${c.entities.slice(0, 12).map((e) => `${e.name} (${e.type}, ${e.count})`).join(", ")}`)
    const prompts = dedupePrompts(c.frequent_prompts)
    if (prompts.length) parts.push(`### Frequent prompts\n${prompts.map((f) => `- "${f.summary}" (${f.count} time${f.count === 1 ? "" : "s"}, last on ${shortDate(f.last)})`).join("\n")}`)
    if (c.decisions.length) parts.push(`### Recent decisions\n${c.decisions.slice(0, 8).map((i) => `- ${i.title} (${zoneName(i.zone)}, ${shortDate(i.created_at)})`).join("\n")}`)
    if (c.procedures.length) parts.push(`### Procedures\n${c.procedures.slice(0, 8).map((i) => `- ${i.title} (${zoneName(i.zone)})`).join("\n")}`)
    parts.push("Useful for a handover: search_brain then opens the details of each subject.")
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
  if (!s || !s.headline) return "The company status has not been generated yet (an admin can refresh it from the dashboard, or with `brain.mjs refresh-status`)."
  const zones = (s.zones ?? []).map((z) => {
    const lines = [`### ${zoneName(z.zone)}`, z.summary, `Progress: ${z.progress}`]
    if (z.objectives.length) lines.push(`Goals: ${z.objectives.join("; ")}`)
    if (z.next_steps.length) lines.push(`Next steps: ${z.next_steps.join("; ")}`)
    if (z.who_did_what.length) lines.push(`Who did what: ${z.who_did_what.map((w) => `${w.person} — ${w.did}`).join("; ")}`)
    return lines.join("\n")
  })
  return `## Where does the company stand?\n${s.headline}\n\n${zones.join("\n\n")}\n\n(generated on ${shortDate(s.generated_at)}, ${s.generator === "claude" ? "by Claude" : "automatically"})`
}
