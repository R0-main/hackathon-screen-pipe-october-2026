// `claude -p` : jamais en mode --bare (il ignore CLAUDE_CODE_OAUTH_TOKEN), et un jeton expiré ou révoqué
// (« Please run /login ») est une panne du poste, avec un message clair, jamais un échec décompté par conversation.

import { strict as assert } from "node:assert"
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import type { StatusInput } from "@brain/core"
import { apiFailure, classifyFailure, claudeCliArgs, cliFailure } from "../src/distill"
import { cmdRefreshStatus } from "../src/refresh-status"
import { runSync } from "../src/sync"
import { fakeClaude, withPath } from "./fake-claude"
import { mockServer, tempDir } from "./helpers"
import { mockBrain } from "./mock-brain"

const srcDir = fileURLToPath(new URL("../src", import.meta.url))
// La fausse CLI annonce --bare dans son aide : il ne doit jamais être repris.
const HELP = "--bare --no-session-persistence --tools --model"
// Assemblé à l'exécution : aucun motif de jeton en clair dans le dépôt.
const CLAUDE_TOKEN = ["sk-ant-", "oat01-", "Tk4", "w".repeat(48)].join("")

const ts = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
const line = (o: unknown) => JSON.stringify(o) + "\n"
const session = (s: string, q: string, a: string, minAgo: number) =>
  line({ type: "user", sessionId: s, timestamp: ts(minAgo), message: { role: "user", content: q } }) +
  line({ type: "assistant", sessionId: s, timestamp: ts(minAgo - 1), message: { role: "assistant", content: [{ type: "text", text: a }], stop_reason: "end_turn" } })

function capture() {
  const out: string[] = []
  return { io: { log: (s: string) => out.push(s), warn: (s: string) => out.push(s) }, log: (s: string) => out.push(s), text: () => out.join("\n") }
}

function station(url: string, token = "cb_test_token_123456", extra: Record<string, unknown> = {}) {
  const home = tempDir()
  const claude = tempDir()
  const proj = join(claude, "projects", "p")
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(home, "config.json"), JSON.stringify({ url, token, screenpipe_url: "http://127.0.0.1:9", use_claude_cli: true, sources: ["claude"], ...extra }), { mode: 0o600 })
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = claude
  process.env.CODEX_HOME = tempDir()
  delete process.env.ANTHROPIC_API_KEY
  return { home, proj, state: () => JSON.parse(readFileSync(join(home, "state.json"), "utf8")) }
}

const AUTH_HELP = /Claude Code n'est plus connecté sur ce poste : le jeton Claude a expiré ou a été révoqué/
const AUTH_STEPS = /Lancez `claude setup-token`, puis `node ~\/\.company-brain\/brain\.mjs init --claude-token <jeton>` \(ou `claude \/login`\)/

test("classifyFailure / cliFailure : jeton expiré ou révoqué, /login, réseau, quotas ; le reste est propre à la conversation", () => {
  for (const t of [
    "OAuth token has expired. Please obtain a new token or refresh your existing token.",
    "Not logged in · Please run /login",
    "Invalid API key · Please run /login",
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token revoked"}}',
    "OAuth access token has been revoked",
  ])
    assert.equal(classifyFailure(t), "auth", t)
  for (const t of ["API Error: Connection error.", "spawn claude ENOENT", "API Error: 529 Overloaded", "Claude AI usage limit reached|1760000000", "API Error: 429 rate_limit_error", "getaddrinfo ENOTFOUND api.anthropic.com", "Credit balance is too low"])
    assert.equal(classifyFailure(t), "outage", t)
  for (const t of ["Prompt is too long", "Erreur inattendue", "délai de 120 s dépassé", "Error: max turns reached (duration 401 ms, 529 tokens)"]) assert.equal(classifyFailure(t), "conversation", t)

  // Enveloppe is_error avec un code 0 : échec, classé d'après son `result` (les champs numériques ne comptent pas).
  assert.deepEqual(cliFailure({ stdout: JSON.stringify({ is_error: true, duration_ms: 401, result: "Not logged in · Please run /login" }) })?.failure, "auth")
  assert.deepEqual(cliFailure({ stdout: JSON.stringify({ is_error: true, duration_ms: 401, result: "Prompt is too long" }) }), {
    error: "Prompt is too long",
    failure: "conversation",
    signature: "Prompt is too long",
  })
  // Réponse normale (même en prose) : pas un échec de la CLI.
  assert.equal(cliFailure({ stdout: JSON.stringify({ is_error: false, duration_ms: 401, result: "Désolé, je ne peux pas." }) }), null)

  // API Anthropic (statut du dernier appel HTTP).
  assert.equal(apiFailure({ status: 401, body: '{"type":"authentication_error"}' }).failure, "auth")
  assert.equal(apiFailure({ status: 529 }).failure, "outage")
  assert.equal(apiFailure({ network: "fetch failed" }).failure, "outage")
  assert.equal(apiFailure({ status: 400, body: "Your credit balance is too low" }).failure, "outage")
  assert.equal(apiFailure({ status: 200 }).failure, "conversation")
  assert.equal(apiFailure({ status: 200 }).signature, undefined, "le modèle a répondu : Claude fonctionne")
})

test("NO-BARE : aucun `claude -p` (distillation, refresh-status) n'utilise --bare, même si la CLI le propose", async () => {
  const cli = fakeClaude({ help: HELP })
  const brain = await mockBrain()
  const input: StatusInput = { company_name: "Fournil", generated_for: "2026-10-16", zones: [{ id: "dev", name: "Dev", description: "" }], items: [], tasks: [] }
  const status = await mockServer((req) => (req.url.startsWith("/api/status/input") ? { body: input } : undefined))
  try {
    const st = station(brain.url, "cb_test_token_123456", { claude_oauth_token: CLAUDE_TOKEN })
    writeFileSync(join(st.proj, "a.jsonl"), session("a", "QZX1 On part sur quelle base ?", "On part sur Supabase.", 30))
    const r = await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(r.sent, 1)
    station(status.url, "cb_admin", { claude_oauth_token: CLAUDE_TOKEN })
    assert.equal(await withPath(cli.bin, () => cmdRefreshStatus({ dryRun: true }, () => {})), 0)

    const calls = cli.calls()
    assert.ok(calls.some((c) => c.status) && calls.some((c) => !c.status), "distillation et refresh-status appelés")
    for (const c of calls) {
      assert.equal(c.args[0], "-p")
      assert.ok(!c.args.includes("--bare"), `--bare passé : ${c.args.join(" ")}`)
      assert.equal(c.token, CLAUDE_TOKEN, "le jeton de la config doit arriver à claude -p")
    }
    assert.ok(!claudeCliArgs(join(cli.bin, "claude")).includes("--bare"))

    // Un seul endroit construit les arguments de `claude -p` (claudeCliArgs) : pas d'autre lancement qui le contourne.
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]))
    const withP = files(srcDir).filter((f) => f.endsWith(".ts") && /["']-p["']/.test(readFileSync(f, "utf8")))
    assert.deepEqual(withP.map((f) => f.slice(srcDir.length + 1)), ["distill.ts"])
    assert.doesNotMatch(readFileSync(join(srcDir, "distill.ts"), "utf8"), /push\([^)]*["']--bare["']/)
  } finally {
    await brain.close()
    await status.close()
  }
})

test("TOKEN-EXPIRED : jeton Claude expiré → message clair, panne (rien de décompté, rien d'abandonné), tout part une fois reconnecté", async () => {
  const cli = fakeClaude({ help: HELP })
  const brain = await mockBrain()
  try {
    const st = station(brain.url)
    const files = [0, 1, 2, 3, 4].map((k) => join(st.proj, `s${k}.jsonl`))
    files.forEach((f, k) => writeFileSync(f, session(`s${k}`, `QZX${k} Comment on déploie l'API ?`, "On a décidé de déployer avec Vercel.", 60 - k)))
    cli.setMode("expired")
    for (let run = 1; run <= 4; run++) {
      const before = cli.calls().length
      const out = capture()
      const r = await withPath(cli.bin, () => runSync({}, out.io))
      assert.equal(r.failed, 5)
      assert.equal(r.sent, 0)
      // Connexion perdue : on s'arrête aussitôt (au plus les appels déjà lancés en parallèle).
      assert.ok(cli.calls().length - before <= 2, `appels : ${cli.calls().length - before}`)
      assert.match(out.text(), AUTH_HELP)
      assert.match(out.text(), AUTH_STEPS)
      assert.match(out.text(), /OAuth token has expired/)
      assert.match(out.text(), /seront distillées à la prochaine synchro, une fois Claude reconnecté \(aucun essai décompté\)/)
      assert.doesNotMatch(out.text(), /abandonnée|Échec lié au contenu/)
      assert.equal(st.state().distill_failures, undefined, "panne comptée comme échec de conversation")
      for (const f of files) assert.equal(st.state().claude?.files?.[f], undefined)
    }
    cli.setMode("")
    const r = await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(r.failed, 0)
    assert.equal(r.sent, 5)
  } finally {
    await brain.close()
  }
})

test("TOKEN-EXPIRED : jeton révoqué (enveloppe JSON, code 1) et « Please run /login » (code 0) → même message, même panne", async () => {
  for (const mode of ["revoked-json", "login"]) {
    const cli = fakeClaude({ help: HELP })
    const brain = await mockBrain()
    try {
      const st = station(brain.url)
      for (let k = 0; k < 4; k++) writeFileSync(join(st.proj, `s${k}.jsonl`), session(`s${k}`, `QZX${k} Question ?`, "Réponse.", 30 - k))
      cli.setMode(mode)
      const out = capture()
      const r = await withPath(cli.bin, () => runSync({}, out.io))
      assert.equal(r.failed, 4, mode)
      assert.ok(cli.calls().length <= 2, `${mode} : ${cli.calls().length} appels`)
      assert.match(out.text(), AUTH_HELP)
      assert.match(out.text(), AUTH_STEPS)
      assert.match(out.text(), /Please run \/login/)
      assert.equal(st.state().distill_failures, undefined)
    } finally {
      await brain.close()
    }
  }
})

test("TOKEN-EXPIRED : refresh-status explique quoi faire quand le jeton a expiré ou a été révoqué", async () => {
  const input: StatusInput = { company_name: "Fournil", generated_for: "2026-10-16", zones: [{ id: "dev", name: "Dev", description: "" }], items: [], tasks: [] }
  const brain = await mockServer((req) => (req.url.startsWith("/api/status/input") ? { body: input } : undefined))
  try {
    station(brain.url, "cb_admin", { claude_oauth_token: CLAUDE_TOKEN })
    for (const mode of ["expired", "revoked-json", "login"]) {
      const cli = fakeClaude({ help: HELP })
      cli.setMode(mode)
      await assert.rejects(withPath(cli.bin, () => cmdRefreshStatus({}, () => {})), (err: Error) => {
        assert.match(err.message, AUTH_HELP, mode)
        assert.match(err.message, AUTH_STEPS, mode)
        assert.match(err.message, /relancez `refresh-status`/)
        assert.ok(!err.message.includes(CLAUDE_TOKEN))
        return true
      })
    }
    // Autre panne (réseau) : message d'échec générique, pas celui du jeton.
    const cli = fakeClaude({ help: HELP })
    cli.setMode("network")
    await assert.rejects(withPath(cli.bin, () => cmdRefreshStatus({}, () => {})), /`claude -p` a échoué : code 1 : API Error: Connection error/)
  } finally {
    await brain.close()
  }
})

test("TOKEN-EXPIRED : clé API refusée (401) par l'API Anthropic → message clair, arrêt immédiat, rien de décompté", async () => {
  let calls = 0
  const anthropic = await mockServer(() => {
    calls++
    return { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }
  })
  const brain = await mockBrain()
  const prevBase = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = anthropic.url
  const prevError = console.error
  console.error = () => {}
  try {
    const st = station(brain.url, "cb_test_token_123456", { anthropic_api_key: ["sk-ant-", "api03-", "z".repeat(30)].join("") })
    for (let k = 0; k < 6; k++) writeFileSync(join(st.proj, `s${k}.jsonl`), session(`s${k}`, `QZX${k} Question ?`, "On a décidé de garder Supabase.", 30 - k))
    const out = capture()
    const r = await withPath(null, () => runSync({}, out.io))
    assert.equal(r.distiller, "claude-api")
    assert.equal(r.failed, 6)
    assert.match(out.text(), /Clé API Anthropic refusée \(« API Anthropic : HTTP 401/)
    assert.match(out.text(), /init --anthropic-key <clé>/)
    // Concurrence 3 : au plus 3 conversations tentées (tri + extraction chacune), puis arrêt.
    assert.ok(calls <= 6, `appels HTTP : ${calls}`)
    assert.equal(st.state().distill_failures, undefined)
  } finally {
    console.error = prevError
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = prevBase
    await brain.close()
    await anthropic.close()
  }
})
