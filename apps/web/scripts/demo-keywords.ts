// Writes the search keywords of the demo's knowledge (demo-data.ts) into demo-keywords.json: npm run demo:keywords
// Same prompt and model as `npm run keywords -- --cli` (claude -p, Haiku). The demo seed gives them to the items it
// inserts, and the demo brain already online gets them once (lib/demo-seed.ts, claim "demo-keywords-v1"). Run it
// again after adding demo knowledge: the items already in the file are kept, unless --all.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CORE_ZONE, DEFAULT_ZONES, KEYWORDS_PROMPT_VERSION, buildCliKeywordsPrompt, parseKeywords } from "@brain/core"
import { DEMO_CORE_ITEMS, DEMO_FOLLOWUP_ITEMS, DEMO_FRESH_ITEMS, DEMO_ITEMS, DEMO_SCREENPIPE_ITEMS, DEMO_USERS } from "./demo-data"
import { pool, runCli } from "./keywords"

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "demo-keywords.json")
const MODEL = "haiku"

async function main() {
  const all = process.argv.includes("--all")
  const names = new Map(DEMO_USERS.map((u) => [u.key, u.name]))
  const zoneNames = new Map([...DEFAULT_ZONES, CORE_ZONE].map((z) => [z.id, z.name]))
  const items = [...DEMO_ITEMS, ...DEMO_SCREENPIPE_ITEMS, ...DEMO_CORE_ITEMS, ...DEMO_FOLLOWUP_ITEMS, ...DEMO_FRESH_ITEMS]
  const titles = new Set<string>()
  for (const it of items) {
    if (titles.has(it.title)) throw new Error(`two demo items titled "${it.title}": the keywords are found by title`)
    titles.add(it.title)
  }
  const known: Record<string, string[]> = !all && fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")).items : {}
  const out: Record<string, string[]> = Object.fromEntries(Object.entries(known).filter(([t]) => titles.has(t)))
  const todo = items.filter((it) => !out[it.title]?.length)
  console.log(`Demo keywords (${KEYWORDS_PROMPT_VERSION}, claude -p, ${MODEL}): ${todo.length} of ${items.length} item(s) to read.`)
  let failed = 0
  await pool(todo, 4, async (it) => {
    const input = { ...it, author: names.get(it.author), zoneName: zoneNames.get(it.zone) }
    try {
      const keywords = parseKeywords(await runCli(buildCliKeywordsPrompt(input), MODEL), it.title)
      if (keywords?.length) out[it.title] = keywords
      else failed++
    } catch (err) {
      failed++
      console.error(`  ✗ ${it.title}: ${err instanceof Error ? err.message : err}`)
    }
  })
  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(FILE, `${JSON.stringify({ prompt: KEYWORDS_PROMPT_VERSION, model: MODEL, items: sorted }, null, 2)}\n`)
  console.log(`✓ ${Object.keys(sorted).length} item(s) in ${path.basename(FILE)}${failed ? `, ${failed} without an answer (run it again)` : ""}.`)
  if (failed) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
