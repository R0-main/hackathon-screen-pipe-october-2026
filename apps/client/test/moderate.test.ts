// `brain moderate`: the brain's material → Claude Code here (fake CLI) → decisions sent back by id.

import { strict as assert } from "node:assert"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { buildModerationInput } from "@brain/core"
import { cmdModerate, scheduledModeration } from "../src/moderate"
import { fakeClaude, withPath } from "./fake-claude"
import { mockServer, tempDir } from "./helpers"

const TOKEN = "cb_test_token_123456"
const zones = [
  { id: "dev", name: "Dev", description: "Engineering", keywords: [] },
  { id: "finance", name: "Finance", description: "Money", keywords: [] },
]
const item = (id: string, title: string) => ({ id, author: "Hugo Bernard", zone: "dev", kind: "fact" as const, title, body: `${title}.`, source: { tool: "agent", app: "Screenpipe" } })

async function brain(material: unknown) {
  const posted: unknown[] = []
  const srv = await mockServer((req) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: { error: "Not authenticated" } }
    if (req.method === "GET" && req.url === "/api/admin/moderation/input") return { body: material }
    if (req.method === "POST" && req.url === "/api/admin/moderation") {
      posted.push(req.body)
      return { body: { status: "done", reviewed: 3, edited: 1, rejected: 1, remaining: 0 } }
    }
    return undefined
  })
  const home = tempDir()
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: srv.url, token: TOKEN, screenpipe_url: "http://127.0.0.1:9", use_claude_cli: true, sources: ["claude"] }))
  process.env.COMPANY_BRAIN_HOME = home
  return { srv, posted }
}

test("moderate: Claude Code decides, the verdicts go back by id; --dry-run sends nothing", async () => {
  const input = buildModerationInput({
    companyName: "Fournil",
    zones,
    items: [item("a1", "Stripe webhooks in a Redis queue"), item("b2", "QZXPERSO personal appointment"), item("c3", "QZXFIX VAT to file")],
    published: [],
  })
  const { srv, posted } = await brain({ input, remaining: 2 })
  const cli = fakeClaude()
  try {
    const out: string[] = []
    await withPath(cli.bin, () => cmdModerate({ dryRun: true }, (s) => out.push(s)))
    assert.equal(posted.length, 0)
    assert.match(out.join("\n"), /3 knowledge item\(s\) to review \(2 at the next run\)/)
    assert.match(out.join("\n"), /✕ removed: \[dev\] QZXPERSO personal appointment — personal content/)
    assert.match(out.join("\n"), /✎ edited: \[dev\] QZXFIX VAT to file → Fixed title \(to finance\)/)

    const run = [] as string[]
    await withPath(cli.bin, () => cmdModerate({}, (s) => run.push(s)))
    const body = posted[0] as { ids: string[]; verdicts: { id: string; decision: string; category: string | null }[] }
    assert.deepEqual(body.ids, ["a1", "b2", "c3"])
    assert.deepEqual(
      body.verdicts.map((v) => [v.id, v.decision, v.category]),
      [
        ["a1", "publish", null],
        ["b2", "reject", "personal"],
        ["c3", "edit", null],
      ],
    )
    assert.match(run.join("\n"), /Moderator: 3 reviewed, 1 edited, 1 removed\./)
    const call = cli.calls().at(-1)!
    assert.equal(call.args[call.args.indexOf("--model") + 1], "sonnet")
  } finally {
    await srv.close()
  }
})

test("moderate: nothing to review, or moderator off → no call to Claude", async () => {
  for (const skipped of ["nothing", "off"]) {
    const { srv } = await brain({ skipped })
    const cli = fakeClaude()
    try {
      const out: string[] = []
      await withPath(cli.bin, () => cmdModerate({}, (s) => out.push(s)))
      assert.equal(cli.calls().length, 0)
      assert.match(out.join("\n"), skipped === "off" ? /is off/ : /nothing new/)
    } finally {
      await srv.close()
    }
  }
})

test("scheduled sync: only an admin's computer does the moderator run", async () => {
  const input = buildModerationInput({ companyName: "Fournil", zones, items: [item("a1", "Stripe webhooks in a Redis queue")], published: [] })
  const { srv, posted } = await brain({ input, remaining: 0 })
  const cli = fakeClaude()
  try {
    const cache = (role: string) =>
      writeFileSync(
        join(process.env.COMPANY_BRAIN_HOME!, "cache.json"),
        JSON.stringify({ updated_at: new Date().toISOString(), whoami: { name: "Claire", org: "Fournil", role, readable: [], writable: [] } }),
      )
    cache("member")
    await withPath(cli.bin, () => scheduledModeration(() => {}))
    assert.equal(posted.length, 0)
    cache("admin")
    const out: string[] = []
    await withPath(cli.bin, () => scheduledModeration((s) => out.push(s)))
    assert.equal(posted.length, 1)
    // Summary afterwards: the summary route is missing on this fake brain, the error stays in the log.
    assert.match(out.join("\n"), /Moderator: 3 reviewed/)
  } finally {
    await srv.close()
  }
})
