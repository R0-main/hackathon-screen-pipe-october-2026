// Writes the search keywords of the knowledge already in the brain (packages/core/src/keywords.ts): npm run keywords
// A model reads one knowledge item at a time, with its source (zone, author, app, date), and writes the terms a
// colleague might type to find it that its text does not contain. Only items without keywords, unless --all.
//
//   npm run keywords                    the company's Claude key (or ANTHROPIC_API_KEY), otherwise the `claude` CLI
//   npm run keywords -- --cli           always through `claude -p` (a Claude Code subscription, no API key)
//   npm run keywords -- --model sonnet  another model (default: Haiku, as at ingestion)
//   npm run keywords -- --all           every item again, after a change of the prompt
//   npm run keywords -- --export f.json the keywords, by title, with the prompt version and the model (evaluation data)
//
// The database's default company; BRAIN_ORG_ID=<uuid> for a company created from /create. On Postgres, migration
// 20261027000001.

import { spawn } from "node:child_process"
import fs from "node:fs"
import { KEYWORDS_MODEL, suggestKeywords } from "@brain/core/claude"
import { KEYWORDS_PROMPT_VERSION, buildCliKeywordsPrompt, parseKeywords, type KeywordsInput, type KnowledgeItem } from "@brain/core"
import { getClaude } from "../lib/ai"
import { getRootStore, storeForOrg } from "../lib/store"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const option = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

/** `claude -p` for one prompt: plain text out, no tools, no saved session, ignored by the brain's own hooks. */
function runCli(prompt: string, model: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_PATH || "claude", ["-p", "--output-format", "text", "--model", model, "--no-session-persistence", "--tools", ""], {
      env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (err += d))
    child.on("error", reject)
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`claude -p exited with ${code}: ${err.trim().slice(0, 200)}`))
    })
    child.stdin.end(prompt)
  })
}

/** Runs `fn` on every element, `n` at a time. */
async function pool<T>(list: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) {
      const i = next++
      await fn(list[i], i)
    }
  }))
}

async function main() {
  const root = getRootStore()
  const store = process.env.BRAIN_ORG_ID ? storeForOrg(process.env.BRAIN_ORG_ID) : root
  const client = flag("cli") ? null : await getClaude(store)
  const model = option("model") ?? (client ? KEYWORDS_MODEL : "haiku")
  const concurrency = Number(option("concurrency") ?? 4)
  const [items, profiles, zones] = await Promise.all([store.listItems({ limit: 100_000, excludeSuperseded: true }), store.listProfiles(), store.listZones()])
  const names = new Map(profiles.map((p) => [p.id, p.name]))
  const zoneNames = new Map(zones.map((z) => [z.id, z.name]))
  const todo = flag("all") ? items : items.filter((i) => !i.keywords?.length)
  console.log(`Keywords (${KEYWORDS_PROMPT_VERSION}, ${client ? "Claude API" : "claude -p"}, ${model}): ${todo.length} knowledge item(s) to read, ${concurrency} at a time.`)
  const input = (i: KnowledgeItem): KeywordsInput => ({ ...i, author: names.get(i.author_id), zoneName: zoneNames.get(i.zone) })
  let done = 0
  let failed = 0
  await pool(todo, concurrency, async (item) => {
    let keywords: string[] | null = null
    try {
      keywords = client ? await suggestKeywords(client, input(item), model) : parseKeywords(await runCli(buildCliKeywordsPrompt(input(item)), model), item.title)
    } catch (err) {
      console.error(`  ✗ ${item.title}: ${err instanceof Error ? err.message : err}`)
    }
    if (!keywords?.length) {
      failed++
      return
    }
    await store.setKeywords([{ id: item.id, keywords }])
    item.keywords = keywords
    if (++done % 10 === 0) console.log(`· ${done}/${todo.length}`)
  })
  console.log(`✓ done: ${done} knowledge item(s) with keywords${failed ? `, ${failed} without an answer (run it again)` : ""}.`)
  const file = option("export")
  if (file) {
    const byTitle = Object.fromEntries(items.filter((i) => i.keywords?.length).sort((a, b) => a.title.localeCompare(b.title)).map((i) => [i.title, i.keywords]))
    fs.writeFileSync(file, `${JSON.stringify({ prompt: KEYWORDS_PROMPT_VERSION, model, items: byTitle }, null, 2)}\n`)
    console.log(`✓ ${Object.keys(byTitle).length} item(s) written to ${file}`)
  }
  const s = root as { end?: () => Promise<void> }
  if (typeof s.end === "function") await s.end()
  if (failed) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
