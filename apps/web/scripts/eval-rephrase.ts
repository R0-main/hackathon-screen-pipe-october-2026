// Writes the rewordings an agent would send to search_brain for each question of the evaluation, one `claude -p` call
// per question, with the same guidance as the tool's `phrasings` parameter (PHRASINGS_GUIDANCE): what the evaluation
// measures is what agents are asked to do. The agent sees the question and the company, never the brain's content.
//
//   tsx scripts/eval-rephrase.ts --model sonnet --out scripts/eval-data/rephrasings.json
//   tsx scripts/eval-rephrase.ts --model haiku  --out scripts/eval-data/rephrasings-haiku.json   (the lower bound)
//
// Then EVAL_REPHRASINGS=<file> npm run eval. Questions already in the file are kept (--all to write them again).

import { spawn } from "node:child_process"
import fs from "node:fs"
import { DISTILL_MARKER } from "@brain/core"
import { PHRASINGS_GUIDANCE } from "@brain/core/mcp"
import { DEMO_ORG } from "./demo-data"
import { ACCESS_CASES, CASE_SETS, GRAPH_CASES, UNANSWERABLE } from "./eval-cases"

/** Version of the prompt below, kept in the file it writes. */
export const REPHRASE_PROMPT_VERSION = "rephrase-v2"

const args = process.argv.slice(2)
const option = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

export function buildRephrasePrompt(question: string): string {
  return `${DISTILL_MARKER}
You are an AI agent working for ${DEMO_ORG.name}: ${DEMO_ORG.description}
To answer the user's question below, you search the company's shared brain with the search_brain tool. It takes the
question as the user asked it, and \`phrasings\`:
${PHRASINGS_GUIDANCE}

The user's question: ${question}

Reply ONLY with a JSON object of the form {"phrasings":["…","…"]}, with 2 phrasings. No text around it, no code block.`
}

function parsePhrasings(text: string): string[] | null {
  const s = text.trim()
  const start = s.indexOf("{")
  const end = s.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const p = (JSON.parse(s.slice(start, end + 1)) as { phrasings?: unknown }).phrasings
    const list = Array.isArray(p) ? p.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, 3) : []
    return list.length ? list : null
  } catch {
    return null
  }
}

function runCli(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_PATH || "claude", ["-p", "--output-format", "text", "--model", model, "--no-session-persistence", "--tools", ""], {
      env: { ...process.env, COMPANY_BRAIN_INTERNAL: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000)
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

async function main() {
  const model = option("model") ?? "sonnet"
  const out = option("out")
  if (!out) throw new Error("--out <file.json> is required.")
  const concurrency = Number(option("concurrency") ?? 6)
  const questions = [
    ...new Set([...CASE_SETS.flatMap((s) => s.cases.map((c) => c.query)), ...GRAPH_CASES.map((c) => c.query), ...UNANSWERABLE, ...ACCESS_CASES.map((c) => c.query)]),
  ]
  const previous = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, "utf8")) as { questions?: Record<string, string[]> }).questions ?? {} : {}
  const result: Record<string, string[]> = args.includes("--all") ? {} : { ...previous }
  const todo = questions.filter((q) => !result[q])
  console.log(`Rephrasings (${REPHRASE_PROMPT_VERSION}, ${model}): ${todo.length} question(s), ${concurrency} at a time.`)
  let next = 0
  let failed = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
      while (next < todo.length) {
        const q = todo[next++]
        const phrasings = await runCli(buildRephrasePrompt(q), model).then(parsePhrasings).catch(() => null)
        if (phrasings) result[q] = phrasings
        else failed++
      }
    }),
  )
  const ordered = Object.fromEntries(questions.filter((q) => result[q]).map((q) => [q, result[q]]))
  fs.writeFileSync(out, `${JSON.stringify({ prompt: REPHRASE_PROMPT_VERSION, model, questions: ordered }, null, 2)}\n`)
  console.log(`✓ ${Object.keys(ordered).length}/${questions.length} question(s) in ${out}${failed ? `, ${failed} without an answer (run it again)` : ""}`)
  if (failed) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
