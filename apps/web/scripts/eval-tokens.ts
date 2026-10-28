// What search_brain costs an agent to read: the size in tokens of its answer, in full (every result's text) and in
// the compact format (the 3 best in full, the next ones in one line, 2 documents at most), on the questions of the
// evaluation, as an admin (every zone). In the compact format, a question whose expected answer is only listed in one
// line costs a get_knowledge read on top: counted too.
//
//   tsx scripts/eval-tokens.ts                     sizes in characters, and the answers kept in --out
//   tsx scripts/eval-tokens.ts --count             tokens counted by Claude itself (one `claude -p` per answer, Haiku)
//
// EVAL_REPHRASINGS as for npm run eval. Each search is recorded as an event, like an agent's: run it on a local copy.

import { spawn } from "node:child_process"
import fs from "node:fs"
import { COMPACT_FORMAT, formatKnowledge, formatQuery, type QueryResult } from "@brain/core/mcp"
import { getAccess } from "../lib/access"
import { queryBrain } from "../lib/brain"
import { getStore, runInOrg } from "../lib/store"
import { CASE_SETS, type Case } from "./eval-cases"
import { CORPUS_MARKER } from "./eval-corpus"

const args = process.argv.slice(2)
const rephrasingsFile = process.env.EVAL_REPHRASINGS ? JSON.parse(fs.readFileSync(process.env.EVAL_REPHRASINGS, "utf8")) : null
const REPHRASINGS: Record<string, string[]> = rephrasingsFile?.questions ?? rephrasingsFile ?? {}

/** Total input tokens Claude counts for a prompt (cached or not). */
function promptTokens(text: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json", "--model", "haiku", "--no-session-persistence", "--tools", ""], {
      env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" },
    })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.on("error", reject)
    child.on("close", () => {
      try {
        const u = JSON.parse(out).usage
        resolve(u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0))
      } catch (err) {
        reject(err)
      }
    })
    child.stdin.end(`Reply ok.\n${text}`)
  })
}

const rankOf = (items: { title: string }[], c: Pick<Case, "expect">) => {
  const wanted = (Array.isArray(c.expect) ? c.expect : [c.expect]).map((e) => e.toLowerCase())
  return items.findIndex((r) => wanted.some((w) => r.title.toLowerCase().includes(w)))
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const at = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))]
  return { mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length), median: at(0.5), p90: at(0.9), max: s[s.length - 1] }
}

async function main() {
  const store = getStore()
  const profiles = await store.listProfiles()
  const admin = profiles.find((p) => p.role === "admin")
  if (!admin) throw new Error("No admin: run npm run seed first.")
  const rows: { query: string; full: string; compact: string; read: string | null; rank: number }[] = []
  await runInOrg(admin.org_id, async () => {
    const viewer = { profile: admin, real: admin, access: await getAccess(admin) }
    const zones = new Map((await store.listZones()).map((z) => [z.id, z.name]))
    const zoneName = (id: string) => zones.get(id) ?? id
    const withCorpus = (await store.listItems({ limit: 5000 })).some((i) => i.title === CORPUS_MARKER)
    for (const set of CASE_SETS.filter((s) => !s.corpus || withCorpus))
      for (const c of set.cases) {
        const r = (await queryBrain(viewer, { query: c.query, phrasings: REPHRASINGS[c.query] })) as unknown as QueryResult
        const rank = rankOf(r.items, c)
        // The expected answer only listed in one line: the agent reads it with get_knowledge.
        const read = rank >= COMPACT_FORMAT.full ? formatKnowledge([r.items[rank]], [r.items[rank].id], zoneName) : null
        rows.push({ query: c.query, full: formatQuery(r, zoneName), compact: formatQuery(r, zoneName, COMPACT_FORMAT), read, rank })
      }
  })
  const out = args[args.indexOf("--out") + 1]
  if (args.includes("--out") && out) fs.writeFileSync(out, JSON.stringify(rows, null, 1))
  const chars = (k: "full" | "compact") => stats(rows.map((r) => r[k].length))
  console.log(`${rows.length} questions${process.env.EVAL_REPHRASINGS ? " with the agent's phrasings" : ""}, 8 results each`)
  console.log(`characters: full ${JSON.stringify(chars("full"))}, compact ${JSON.stringify(chars("compact"))}`)
  const reads = rows.filter((r) => r.read)
  console.log(`compact: ${reads.length} question(s) whose expected answer is only listed in one line (rank 4 to 8), read with get_knowledge`)
  if (!args.includes("--count")) return
  const base = await promptTokens("")
  const texts = rows.flatMap((r) => [r.full, r.compact, ...(r.read ? [r.read] : [])])
  const counted = new Map<string, number>()
  let next = 0
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < texts.length) {
        const t = texts[next++]
        if (!counted.has(t)) counted.set(t, (await promptTokens(t)) - base)
      }
    }),
  )
  const tok = (t: string) => counted.get(t) ?? 0
  const full = rows.map((r) => tok(r.full))
  const compact = rows.map((r) => tok(r.compact))
  const withReads = rows.map((r) => tok(r.compact) + (r.read ? tok(r.read) + 60 : 0))
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  console.log(`tokens (counted by Claude): full ${JSON.stringify(stats(full))}`)
  console.log(`tokens: compact ${JSON.stringify(stats(compact))}`)
  console.log(`tokens: compact + the get_knowledge reads (and ~60 tokens for the call) ${JSON.stringify(stats(withReads))}`)
  console.log(`saved: ${Math.round((1 - sum(withReads) / sum(full)) * 100)}% of what search_brain costs to read, reads included`)
  console.log(`chars per token: ${(sum(rows.map((r) => r.full.length)) / sum(full)).toFixed(2)}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
