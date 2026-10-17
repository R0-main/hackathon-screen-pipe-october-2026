// `claude -p` : jamais en mode --bare (il ignore CLAUDE_CODE_OAUTH_TOKEN), et un jeton expiré ou révoqué
// (« Please run /login ») est une panne du poste, avec un message clair, jamais un échec décompté par conversation.

import { strict as assert } from "node:assert"
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import type { StatusInput } from "@brain/core"
import { apiFailure, classifyFailure, claudeCliArgs, claudeCliEnv, cliFailure, runClaudeCli, statusFailure, unreadableFailure } from "../src/distill"
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
  // Limites d'abonnement, telles que les écrit la CLI installée.
  for (const t of [
    "You've hit your session limit · resets 3pm",
    "You've hit your weekly limit · resets Oct 20, 3pm",
    "You've hit your Opus limit · resets Oct 20, 3pm · /upgrade to keep using Claude Code",
    "You've hit your limit",
    "You're out of usage credits · resets 3pm",
    "Your org is out of usage · add funds to continue",
    "Session limit reached",
    "5-hour limit reached ∙ resets 3pm",
    "API Error: Rate limit exceeded",
    "Overloaded",
  ])
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

  // Statut HTTP numérique de l'enveloppe (api_error_status) : 401/403 → connexion, 429/529/5xx → panne, quel que soit le texte.
  const env = (status: number, result = "Erreur inattendue") => cliFailure({ stdout: JSON.stringify({ type: "result", is_error: true, api_error_status: status, duration_ms: 640, result }) })
  assert.deepEqual(env(429, "You've hit your session limit · resets 3pm"), { error: "You've hit your session limit · resets 3pm", failure: "outage" })
  for (const [status, kind] of [[401, "auth"], [403, "auth"], [429, "outage"], [500, "outage"], [503, "outage"], [529, "outage"]] as const) assert.equal(env(status)?.failure, kind, String(status))
  assert.equal(env(400)?.failure, "conversation", "400 : classé d'après le texte")
  assert.equal(env(400, "Not logged in · Please run /login")?.failure, "auth")
  assert.equal(statusFailure("429"), null, "seul un nombre compte")
  assert.equal(statusFailure(null), null)

  // Sortie sans JSON : le modèle a répondu (échec propre à la conversation)… sauf un texte court qui se lit comme une erreur
  // de la CLI, qui ne prouve rien (traité comme une erreur inconnue, avec signature), jamais comme une panne.
  assert.equal(unreadableFailure(JSON.stringify({ is_error: false, result: "Désolé, je préfère ne pas traiter cette conversation." })).signature, undefined)
  const lim = unreadableFailure(JSON.stringify({ is_error: false, result: "You've hit your session limit · resets 3pm" }))
  assert.equal(lim.failure, "conversation")
  assert.equal(lim.signature, "You've hit your session limit · resets 3pm")
  assert.equal(unreadableFailure(JSON.stringify({ is_error: false, result: `Résumé : ${"on parle du rate limit de l'API. ".repeat(20)}` })).signature, undefined, "une longue réponse en prose reste une réponse")
  assert.equal(unreadableFailure("").signature, "sortie vide")
  assert.equal(unreadableFailure(JSON.stringify({ type: "result", is_error: false })).signature, "sortie vide")

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

test("R-SIMPLE : CLAUDE_CODE_SIMPLE (équivalent de --bare) n'est jamais transmis à `claude -p`, qui lit donc le jeton", async () => {
  const base = { PATH: "/usr/bin", CLAUDE_CODE_SIMPLE: "1", HOME: "/home/x" }
  const env = claudeCliEnv({ oauthToken: CLAUDE_TOKEN }, base)
  assert.equal(env.CLAUDE_CODE_SIMPLE, undefined)
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_TOKEN)
  assert.equal(env.COMPANY_BRAIN_INTERNAL, "1")
  assert.equal(base.CLAUDE_CODE_SIMPLE, "1", "l'environnement du processus n'est pas modifié")

  // De bout en bout : brain.mjs lancé depuis une session `claude --bare` (variable héritée).
  const cli = fakeClaude({ help: HELP })
  const brain = await mockBrain()
  const prev = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = "1"
  try {
    const st = station(brain.url, "cb_test_token_123456", { claude_oauth_token: CLAUDE_TOKEN })
    writeFileSync(join(st.proj, "a.jsonl"), session("a", "QZX1 On part sur quelle base ?", "On part sur Supabase.", 30))
    const r = await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(r.sent, 1)
    assert.ok(cli.calls().length > 0)
    for (const c of cli.calls()) {
      assert.equal(c.simple, null, "CLAUDE_CODE_SIMPLE transmis à claude -p")
      assert.equal(c.token, CLAUDE_TOKEN)
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SIMPLE
    else process.env.CLAUDE_CODE_SIMPLE = prev
    await brain.close()
  }
})

test("R-LIMIT : limite d'abonnement (api_error_status 429), synchros répétées → rien de décompté ni d'abandonné, tout part après la remise à zéro", async () => {
  const cli = fakeClaude({ help: HELP })
  const brain = await mockBrain()
  try {
    const st = station(brain.url)
    const f = join(st.proj, "lim.jsonl")
    writeFileSync(f, session("lim", "QZXLIM7 On migre la base vers Supabase cette semaine ?", "Oui, décision prise : migration jeudi.", 20))
    cli.setMode("limit")
    for (let run = 1; run <= 5; run++) {
      const out = capture()
      const r = await withPath(cli.bin, () => runSync({}, out.io))
      assert.equal(r.failed, 1)
      assert.match(out.text(), /You've hit your session limit/)
      assert.match(out.text(), /Panne générale \(Claude injoignable ou saturé\) : aucun essai n'est décompté/)
      assert.doesNotMatch(out.text(), /abandonnée|Échec lié au contenu/)
      assert.equal(st.state().distill_failures, undefined, "limite d'abonnement décomptée comme un échec de la conversation")
      assert.equal(st.state().claude?.files?.[f], undefined, "checkpoint avancé pendant la limite")
    }
    // Même limite, texte seul (sans enveloppe ni statut) : reconnue aussi.
    cli.setMode("limit-text")
    const out = capture()
    await withPath(cli.bin, () => runSync({}, out.io))
    assert.match(out.text(), /You've hit your weekly limit/)
    assert.equal(st.state().distill_failures, undefined)
    // La limite est levée : la conversation part.
    cli.setMode("")
    const r = await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(r.sent, 1)
    assert.ok(JSON.stringify(brain.received).includes("QZXLIM7"))
    assert.ok(st.state().claude.files[f])
  } finally {
    await brain.close()
  }
})

test("R-LIMIT : limite atteinte en cours de synchro (2 appels réussis) → les conversations suivantes ne sont pas décomptées", async () => {
  const cli = fakeClaude({ help: HELP })
  const brain = await mockBrain()
  try {
    const st = station(brain.url)
    for (let k = 0; k < 6; k++) writeFileSync(join(st.proj, `m${k}.jsonl`), session(`m${k}`, `QZXM${k} Comment on déploie l'API ?`, "On a décidé de déployer avec Vercel.", 60 - k))
    cli.setMode("limit")
    cli.allow(2)
    const out = capture()
    const r = await withPath(cli.bin, () => runSync({}, out.io))
    assert.equal(r.sent, 2)
    assert.equal(r.failed, 4)
    assert.match(out.text(), /Panne \(Claude injoignable ou saturé\) : aucun essai n'est décompté/)
    assert.doesNotMatch(out.text(), /abandonnée|Échec lié au contenu/)
    assert.deepEqual(Object.values(st.state().distill_failures ?? {}).filter((x) => (x as { n: number }).n > 0), [])
    cli.setMode("")
    const r2 = await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(r2.failed, 0)
    assert.deepEqual(tagsOf(brain.ingested), ["QZXM0", "QZXM1", "QZXM2", "QZXM3", "QZXM4", "QZXM5"])
  } finally {
    await brain.close()
  }
})

const tagsOf = (v: unknown) => [...new Set([...JSON.stringify(v).matchAll(/QZX[A-Z]*\d+/g)].map((m) => m[0]))].sort()

test("R-LIMIT : erreur inconnue sans aucune réponse de Claude (formulation de panne inconnue) → jamais abandonnée avant 24 h et 5 essais", async () => {
  const cli = fakeClaude({ help: HELP })
  const brain = await mockBrain()
  try {
    const st = station(brain.url)
    const f = join(st.proj, "w.jsonl")
    writeFileSync(f, session("w", "QZXW1 On garde Qonto pour la trésorerie ?", "Oui, décision prise.", 20))
    cli.setMode("weird")
    for (let run = 1; run <= 6; run++) {
      const out = capture()
      await withPath(cli.bin, () => runSync({}, out.io))
      assert.match(out.text(), /Panne générale \(Claude n'a répondu à aucun appel\) : aucun essai n'est décompté/)
      assert.match(out.text(), /depuis plus de 24 h \(au moins 5 essais\) sera abandonnée/)
      assert.doesNotMatch(out.text(), /abandonnée après|Échec lié au contenu/)
      const e = st.state().distill_failures?.w
      assert.equal(e?.n, 0, "essai décompté sans preuve")
      assert.equal(e?.tries, run)
      assert.equal(st.state().claude?.files?.[f], undefined)
    }
    // Même texte de limite rendu comme une réponse normale (is_error false) : ne prouve rien non plus.
    cli.setMode("limit-ok")
    await withPath(cli.bin, () => runSync({}, capture().io))
    assert.equal(st.state().distill_failures?.w?.n, 0)

    // Garde-fou : les échecs durent depuis plus de 24 h → abandonnée, le checkpoint avance.
    cli.setMode("weird")
    const state = st.state()
    state.distill_failures.w.first_at = new Date(Date.now() - 25 * 3_600_000).toISOString()
    writeFileSync(join(st.home, "state.json"), JSON.stringify(state))
    const out = capture()
    await withPath(cli.bin, () => runSync({}, out.io))
    assert.match(out.text(), /1 conversation abandonnée après plus de 24 h d'échecs \(5 essais au moins\) : rien n'a été envoyé pour elle/)
    assert.equal(st.state().distill_failures, undefined)
    assert.ok(st.state().claude.files[f], "conversation bloquée : checkpoint toujours pas avancé après 24 h")
    assert.ok(!JSON.stringify(brain.received).includes("QZXW1"))
  } finally {
    await brain.close()
  }
})

test("R-LIMIT : runClaudeCli classe d'après api_error_status (code non nul) ; délai dépassé = erreur inconnue (signature)", async () => {
  const dir = tempDir("cli-run-")
  const script = (name: string, body: string) => {
    const bin = join(dir, name)
    writeFileSync(bin, `#!${process.execPath}\nif (process.argv[2] === "--help") process.exit(0)\nprocess.stdin.resume()\n${body}\n`)
    chmodSync(bin, 0o755)
    return bin
  }
  const envelope = (status: number) => `process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ type: "result", is_error: true, api_error_status: ${status}, duration_ms: 401, result: "Erreur inattendue" })); process.exit(1) })`
  for (const [status, kind] of [[529, "outage"], [429, "outage"], [401, "auth"], [400, "conversation"]] as const) {
    const run = await runClaudeCli(script(`s${status}`, envelope(status)), "prompt", 10_000)
    assert.equal(run.failure, kind, String(status))
    assert.equal(Boolean(run.signature), kind === "conversation", String(status))
  }
  const run = await runClaudeCli(script("slow", "setTimeout(() => process.exit(0), 5000)"), "prompt", 300)
  assert.equal(run.failure, "conversation")
  assert.equal(run.signature, "délai dépassé")
  assert.deepEqual(cliFailure(run), { error: run.error, failure: "conversation", signature: "délai dépassé" })
})
