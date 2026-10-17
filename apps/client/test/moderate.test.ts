// `brain moderate` : matière du cerveau → Claude Code ici (fausse CLI) → décisions renvoyées par identifiant.

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
  { id: "dev", name: "Dev", description: "Technique", keywords: [] },
  { id: "compta", name: "Compta", description: "Finances", keywords: [] },
]
const item = (id: string, title: string) => ({ id, author: "Hugo Bernard", zone: "dev", kind: "fact" as const, title, body: `${title}.`, source: { tool: "agent", app: "Screenpipe" } })

async function brain(material: unknown) {
  const posted: unknown[] = []
  const srv = await mockServer((req) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: { error: "Non authentifié" } }
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

test("moderate : Claude Code décide, les verdicts repartent par identifiant ; --dry-run n'envoie rien", async () => {
  const input = buildModerationInput({
    companyName: "Fournil",
    zones,
    items: [item("a1", "Webhooks Stripe en file Redis"), item("b2", "QZXPERSO rendez-vous perso"), item("c3", "QZXFIX TVA à déclarer")],
    published: [],
  })
  const { srv, posted } = await brain({ input, remaining: 2 })
  const cli = fakeClaude()
  try {
    const out: string[] = []
    await withPath(cli.bin, () => cmdModerate({ dryRun: true }, (s) => out.push(s)))
    assert.equal(posted.length, 0)
    assert.match(out.join("\n"), /3 connaissance\(s\) à relire \(2 au passage suivant\)/)
    assert.match(out.join("\n"), /✕ retirée : \[dev\] QZXPERSO rendez-vous perso — contenu personnel/)
    assert.match(out.join("\n"), /✎ corrigée : \[dev\] QZXFIX TVA à déclarer → Titre corrigé \(vers compta\)/)

    const run = [] as string[]
    await withPath(cli.bin, () => cmdModerate({}, (s) => run.push(s)))
    const body = posted[0] as { ids: string[]; verdicts: { id: string; decision: string; category: string | null }[] }
    assert.deepEqual(body.ids, ["a1", "b2", "c3"])
    assert.deepEqual(
      body.verdicts.map((v) => [v.id, v.decision, v.category]),
      [
        ["a1", "publish", null],
        ["b2", "reject", "personnel"],
        ["c3", "edit", null],
      ],
    )
    assert.match(run.join("\n"), /Modérateur : 3 relue\(s\), 1 corrigée\(s\), 1 retirée\(s\)\./)
    const call = cli.calls().at(-1)!
    assert.equal(call.args[call.args.indexOf("--model") + 1], "sonnet")
  } finally {
    await srv.close()
  }
})

test("moderate : rien à relire, ou modérateur coupé → aucun appel à Claude", async () => {
  for (const skipped of ["nothing", "off"]) {
    const { srv } = await brain({ skipped })
    const cli = fakeClaude()
    try {
      const out: string[] = []
      await withPath(cli.bin, () => cmdModerate({}, (s) => out.push(s)))
      assert.equal(cli.calls().length, 0)
      assert.match(out.join("\n"), skipped === "off" ? /coupé/ : /rien de nouveau/)
    } finally {
      await srv.close()
    }
  }
})

test("synchro planifiée : seul le poste d'un admin fait le passage du modérateur", async () => {
  const input = buildModerationInput({ companyName: "Fournil", zones, items: [item("a1", "Webhooks Stripe en file Redis")], published: [] })
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
    // Résumé ensuite : la route du résumé manque sur ce faux cerveau, l'erreur reste dans le journal.
    assert.match(out.join("\n"), /Modérateur : 3 relue/)
  } finally {
    await srv.close()
  }
})
