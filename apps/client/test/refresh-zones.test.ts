// refresh-zones : le passage « nouvelles zones » fait par le Claude Code de l'entreprise (abonnement, jeton en CI).
// Jamais la vraie CLI : une fausse `claude` enregistre son environnement et son entrée standard.

import { strict as assert } from "node:assert"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { DISTILL_MARKER, type NewZonesInput } from "@brain/core"
import { cmdRefreshZones } from "../src/refresh-zones"
import { mockServer, tempDir } from "./helpers"

const ADMIN = "cb_admin_token_abcdef"
const MEMBER = "cb_member_token_abcdef"
// Assemblé à l'exécution : aucun motif de jeton en clair dans le dépôt.
const CLAUDE_TOKEN = ["sk-ant-", "oat01-", "Zz9", "q".repeat(48)].join("")

const item = (ref: number, zone: string, title: string) => ({ ref, id: `id-${ref}`, author_id: "u1", zone, kind: "fact" as const, title, body: `${title}.` })
const INPUT: NewZonesInput = {
  company_name: "Fournil",
  zones: [
    { id: "direction", name: "Direction", description: "Stratégie", keywords: [] },
    { id: "dev", name: "Dev", description: "Code", keywords: [] },
  ],
  items: [item(1, "direction", "Modèle de contrat"), item(2, "direction", "CGV"), item(3, "direction", "RGPD"), item(4, "dev", "Mentions légales"), item(5, "dev", "Déploiement")],
}

/** Faux cerveau : matière et application réservées à l'admin ; `skipped` simule une entreprise trop petite. */
async function zonesBrain(opts: { skipped?: string } = {}) {
  const applied: unknown[] = []
  const srv = await mockServer((req) => {
    const auth = req.headers.authorization
    if (auth !== `Bearer ${ADMIN}` && auth !== `Bearer ${MEMBER}`) return { status: 401, body: { error: "Non authentifié" } }
    if (auth !== `Bearer ${ADMIN}`) return { status: 403, body: { error: "Réservé aux admins." } }
    const path = req.url.split("?")[0]
    if (req.method === "GET" && path === "/api/admin/zones/auto/input") return { body: opts.skipped ? { skipped: opts.skipped } : { input: INPUT } }
    if (req.method === "POST" && path === "/api/admin/zones/auto") {
      const zones = (req.body as { zones: { name: string; item_ids: string[] }[] }).zones
      applied.push(zones)
      return { body: zones.length ? { status: "created", zones: zones.map((z) => ({ id: z.name.toLowerCase(), name: z.name, items: z.item_ids.length, readers: 1 })) } : { status: "unchanged" } }
    }
    return undefined
  })
  return { ...srv, applied }
}

/** Fausse CLI `claude` : répond `answer` dans l'enveloppe JSON de `claude -p`. */
function fakeClaude(answer: unknown) {
  const dir = tempDir()
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(dir, "answer.json"), JSON.stringify({ type: "result", is_error: false, result: "```json\n" + JSON.stringify(answer) + "\n```" }))
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "--help" ]; then echo "--no-session-persistence --tools"; exit 0; fi
cat > "${dir}/stdin"
printf '%s' "\${CLAUDE_CODE_OAUTH_TOKEN-<absent>}" > "${dir}/token"
cat "${dir}/answer.json"
`,
  )
  chmodSync(join(bin, "claude"), 0o755)
  return {
    bin,
    called: () => existsSync(join(dir, "stdin")),
    stdin: () => readFileSync(join(dir, "stdin"), "utf8"),
    token: () => readFileSync(join(dir, "token"), "utf8"),
  }
}

function station(url: string, token: string) {
  const home = tempDir()
  writeFileSync(join(home, "config.json"), JSON.stringify({ url, token, screenpipe_url: "http://127.0.0.1:9", sources: ["claude"] }), { mode: 0o600 })
  process.env.COMPANY_BRAIN_HOME = home
  delete process.env.ANTHROPIC_API_KEY
}

async function withEnv<T>(bin: string, env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev = { PATH: process.env.PATH, ...Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]])) }
  process.env.PATH = [bin, "/usr/bin", "/bin"].join(delimiter)
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}

function logs() {
  const out: string[] = []
  return { log: (s: string) => out.push(s), text: () => out.join("\n") }
}

test("refresh-zones : claude -p (jeton CLAUDE_CODE_OAUTH_TOKEN de la CI) propose, le cerveau reçoit des identifiants", async () => {
  const brain = await zonesBrain()
  const claude = fakeClaude({ zones: [{ name: "Juridique", description: "Contrats et conformité.", keywords: ["contrat"], items: [1, "#2", 3, 4, 99] }] })
  try {
    station(brain.url, ADMIN)
    const l = logs()
    assert.equal(await withEnv(claude.bin, { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN }, () => cmdRefreshZones({}, l.log)), 0)
    assert.ok(claude.stdin().startsWith(DISTILL_MARKER) && claude.stdin().includes("#4 [dev] fact — Mentions légales"), "Claude reçoit la matière numérotée")
    assert.equal(claude.token(), CLAUDE_TOKEN, "le jeton de la CI passe à claude -p")
    assert.deepEqual(brain.applied, [[{ name: "Juridique", description: "Contrats et conformité.", keywords: ["contrat"], item_ids: ["id-1", "id-2", "id-3", "id-4"] }]])
    assert.ok(!JSON.stringify(brain.requests).includes(CLAUDE_TOKEN), "le jeton Claude n'est jamais envoyé au cerveau")
    assert.match(l.text(), /Zone\(s\) créée\(s\) : Juridique \(4 connaissances rangées\)/)
  } finally {
    await brain.close()
  }
})

test("refresh-zones --dry-run : affiche sans rien envoyer ; rien à proposer, le passage est quand même consigné", async () => {
  const brain = await zonesBrain()
  try {
    station(brain.url, ADMIN)
    const dry = fakeClaude({ zones: [{ name: "Juridique", description: "Contrats.", keywords: [], items: [1, 2, 3, 4] }] })
    const l = logs()
    assert.equal(await withEnv(dry.bin, {}, () => cmdRefreshZones({ dryRun: true }, l.log)), 0)
    assert.equal(brain.applied.length, 0)
    assert.match(l.text(), /Juridique — Contrats\. \(4 connaissances\)[\s\S]*Rien n'a été envoyé/)

    const none = fakeClaude({ zones: [] })
    const l2 = logs()
    assert.equal(await withEnv(none.bin, {}, () => cmdRefreshZones({}, l2.log)), 0)
    assert.deepEqual(brain.applied, [[]], "un passage sans proposition apparaît dans l'historique du dashboard")
    assert.match(l2.text(), /aucune nouvelle zone ne s'impose/)
  } finally {
    await brain.close()
  }
})

test("refresh-zones : réservé aux admins ; une entreprise trop petite n'appelle pas Claude", async () => {
  const member = await zonesBrain()
  const claude = fakeClaude({ zones: [] })
  try {
    station(member.url, MEMBER)
    await assert.rejects(
      withEnv(claude.bin, {}, () => cmdRefreshZones({}, () => {})),
      /réservé aux administrateurs/,
    )
  } finally {
    await member.close()
  }
  const small = await zonesBrain({ skipped: "too_few_items" })
  try {
    station(small.url, ADMIN)
    const l = logs()
    assert.equal(await withEnv(claude.bin, {}, () => cmdRefreshZones({}, l.log)), 0)
    assert.equal(claude.called(), false)
    assert.match(l.text(), /pas assez de connaissances récentes/)
  } finally {
    await small.close()
  }
})
