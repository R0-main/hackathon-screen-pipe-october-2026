// refresh-status (résumé « où en est la boîte » produit sur le poste d'un admin) et jeton Claude Code (init --claude-token).
// Jamais la vraie CLI : une fausse `claude` enregistre son environnement, ses arguments et son entrée standard.

import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { DISTILL_MARKER, STATUS_SYSTEM, type StatusInput } from "@brain/core"
import { cmdInit, cmdStatus } from "../src/commands"
import { cmdRefreshStatus } from "../src/refresh-status"
import { runSync } from "../src/sync"
import { TEST_ZONES, mockServer, tempDir, type Recorded } from "./helpers"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
const ADMIN = "cb_admin_token_abcdef"
const MEMBER = "cb_member_token_abcdef"
// Assemblé à l'exécution : aucun motif de jeton en clair dans le dépôt.
const CLAUDE_TOKEN = ["sk-ant-", "oat01-", "Rr7", "q".repeat(48)].join("")

const INPUT: StatusInput = {
  company_name: "Fournil",
  generated_for: "2026-10-16",
  zones: [
    { id: "dev", name: "Dev", description: "Code" },
    { id: "compta", name: "Compta", description: "Factures" },
  ],
  items: [{ zone: "dev", kind: "decision", title: "On part sur Supabase", body: "Choix validé.", author: "Hugo Bernard", created_at: "2026-10-15T10:00:00Z" }],
  tasks: [{ zone: "compta", title: "Clôturer septembre", status: "open", assignee: "Jean-Marc" }],
}

/** Faux cerveau : /api/status/input et POST /api/status réservés à l'admin (403 sinon). */
async function statusBrain() {
  const saved: unknown[] = []
  const srv = await mockServer((req) => {
    const auth = req.headers.authorization
    if (auth !== `Bearer ${ADMIN}` && auth !== `Bearer ${MEMBER}`) return { status: 401, body: { error: "Non authentifié" } }
    const admin = auth === `Bearer ${ADMIN}`
    const path = req.url.split("?")[0]
    if (req.method === "GET" && path === "/api/whoami")
      return {
        body: {
          org: { name: "Fournil", description: "" },
          profile: { id: "u1", org_id: "o", name: "Claire Martin", role: admin ? "admin" : "member", created_at: "" },
          access: { isAdmin: admin, readable: ["dev", "compta"], writable: ["dev", "compta"] },
          context: null,
        },
      }
    if (req.method === "GET" && path === "/api/zones") return { body: { zones: TEST_ZONES } }
    if (path === "/api/status/input" || (path === "/api/status" && req.method === "POST")) {
      if (!admin) return { status: 403, body: { error: "Réservé aux admins." } }
    }
    if (req.method === "GET" && path === "/api/status/input") return { body: INPUT }
    if (req.method === "POST" && path === "/api/status") {
      const status = (req.body as { status: { headline: string; zones: unknown[] } }).status
      saved.push(status)
      return { body: { ...status, generated_at: new Date().toISOString(), generator: "claude" } }
    }
    return undefined
  })
  return { ...srv, saved }
}

/** Fausse CLI `claude` : enregistre env, arguments et prompt ; répond un résumé (bloc de code, zone inconnue comprise). */
function fakeClaude() {
  const dir = tempDir()
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const status = {
    headline: "Fournil avance : Supabase choisi, clôture de septembre en cours.",
    zones: [
      { zone: "dev", summary: "Choix de Supabase.", objectives: ["Migrer"], progress: "En cours", next_steps: ["Écrire le runbook"], who_did_what: [{ person: "Hugo Bernard", did: "a tranché pour Supabase" }] },
      { zone: "rh", summary: "Zone inconnue", objectives: [], progress: "", next_steps: [], who_did_what: [] },
    ],
  }
  const items = { items: [{ zone: "dev", kind: "decision", title: "On part sur Supabase", body: "Choix validé par l'équipe.", entities: [], confidence: 0.9 }] }
  writeFileSync(join(dir, "status.json"), JSON.stringify({ type: "result", is_error: false, result: "Voici le résumé :\n```json\n" + JSON.stringify(status) + "\n```" }))
  writeFileSync(join(dir, "items.json"), JSON.stringify({ result: JSON.stringify(items) }))
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "--help" ]; then echo "--no-session-persistence --tools"; exit 0; fi
n=$(ls "${dir}" | grep -c '^call-')
d="${dir}/call-$n"
mkdir -p "$d"
cat > "$d/stdin"
echo "$@" > "$d/args"
printf '%s' "\${CLAUDE_CODE_OAUTH_TOKEN-<absent>}" > "$d/token"
printf '%s' "\${COMPANY_BRAIN_INTERNAL-<absent>}" > "$d/internal"
if grep -q '"headline"' "$d/stdin"; then cat "${dir}/status.json"; else cat "${dir}/items.json"; fi
`,
  )
  chmodSync(join(bin, "claude"), 0o755)
  const calls = () =>
    Array.from({ length: 20 }, (_, i) => join(dir, `call-${i}`))
      .filter((d) => existsSync(d))
      .map((d) => ({
        stdin: readFileSync(join(d, "stdin"), "utf8"),
        args: readFileSync(join(d, "args"), "utf8").trim(),
        token: readFileSync(join(d, "token"), "utf8"),
        internal: readFileSync(join(d, "internal"), "utf8"),
      }))
  return { bin, calls }
}

function station(url: string, token: string, extra: Record<string, unknown> = {}) {
  const home = tempDir()
  writeFileSync(join(home, "config.json"), JSON.stringify({ url, token, screenpipe_url: "http://127.0.0.1:9", sources: ["claude"], ...extra }), { mode: 0o600 })
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = tempDir()
  process.env.CODEX_HOME = tempDir()
  delete process.env.ANTHROPIC_API_KEY
  return { home, config: () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) }
}

async function withPath<T>(bin: string | null, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PATH
  process.env.PATH = [bin, "/usr/bin", "/bin"].filter(Boolean).join(delimiter)
  try {
    return await fn()
  } finally {
    process.env.PATH = prev
  }
}

function logs() {
  const out: string[] = []
  return { log: (s: string) => out.push(s), text: () => out.join("\n") }
}

test("F-claude-token : init --claude-token l'enregistre (config 600), status le masque, « aucun » le retire", async () => {
  const brain = await statusBrain()
  try {
    const st = station(brain.url, ADMIN)
    const l = logs()
    assert.equal(await cmdInit({ "claude-token": CLAUDE_TOKEN }, l.log), 0)
    assert.equal(st.config().claude_oauth_token, CLAUDE_TOKEN)
    assert.equal(statSync(join(st.home, "config.json")).mode & 0o777, 0o600)
    assert.match(l.text(), /Jeton Claude Code enregistré/)
    assert.ok(!l.text().includes(CLAUDE_TOKEN))
    const s = logs()
    await cmdStatus(s.log)
    assert.match(s.text(), /Jeton Claude Code : sk-ant…qqqq/)
    assert.ok(!s.text().includes(CLAUDE_TOKEN))
    await assert.rejects(cmdInit({ "claude-token": true }, () => {}), /donnez le jeton/)
    await assert.rejects(cmdInit({ "claude-token": "deux mots" }, () => {}), /jeton invalide/)
    await cmdInit({ "claude-token": "aucun" }, () => {})
    assert.equal(st.config().claude_oauth_token, undefined)
    assert.equal(st.config().token, ADMIN)
  } finally {
    await brain.close()
  }
})

test("F-refresh-status : Claude (claude -p) rédige le résumé sur le poste, avec le jeton de la config, puis POST /api/status", async () => {
  const brain = await statusBrain()
  const claude = fakeClaude()
  try {
    station(brain.url, ADMIN, { claude_oauth_token: CLAUDE_TOKEN })
    const l = logs()
    assert.equal(await withPath(claude.bin, () => cmdRefreshStatus({}, l.log)), 0)
    const [call] = claude.calls()
    // Le prompt arrive sur l'entrée standard, commence par DISTILL_MARKER (session jamais ingérée) et contient STATUS_SYSTEM.
    assert.ok(call.stdin.startsWith(DISTILL_MARKER))
    assert.ok(call.stdin.includes(STATUS_SYSTEM))
    assert.match(call.stdin, /On part sur Supabase/)
    assert.match(call.args, /^-p --output-format json/)
    assert.equal(call.token, CLAUDE_TOKEN)
    assert.equal(call.internal, "1")
    // Seules les zones connues partent (la zone « rh » inventée est écartée).
    assert.equal(brain.saved.length, 1)
    const sent = brain.saved[0] as { headline: string; zones: { zone: string }[] }
    assert.match(sent.headline, /Supabase choisi/)
    assert.deepEqual(sent.zones.map((z) => z.zone), ["dev"])
    assert.match(l.text(), /État de l'entreprise mis à jour \(Claude Code/)
    assert.ok(!l.text().includes(CLAUDE_TOKEN))
    const post = brain.requests.find((r: Recorded) => r.method === "POST" && r.url === "/api/status")
    assert.deepEqual(Object.keys(post?.body as object), ["status"])
  } finally {
    await brain.close()
  }
})

test("F-refresh-status --dry-run : affiche le résumé, n'envoie rien", async () => {
  const brain = await statusBrain()
  const claude = fakeClaude()
  try {
    station(brain.url, ADMIN)
    const l = logs()
    await withPath(claude.bin, () => cmdRefreshStatus({ dryRun: true }, l.log))
    assert.match(l.text(), /Où en est la boîte \?/)
    assert.match(l.text(), /Supabase choisi/)
    assert.match(l.text(), /Rien n'a été envoyé \(simulation\)/)
    assert.equal(brain.saved.length, 0)
    // Sans jeton dans la config, aucun CLAUDE_CODE_OAUTH_TOKEN n'est inventé (celui du terminal éventuel est gardé).
    assert.equal(claude.calls()[0].token, process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "<absent>")
  } finally {
    await brain.close()
  }
})

test("F-refresh-status : réservé aux admins (403 → message en français), sans Claude ni clé → message clair", async () => {
  const brain = await statusBrain()
  const claude = fakeClaude()
  try {
    station(brain.url, MEMBER)
    await assert.rejects(
      withPath(claude.bin, () => cmdRefreshStatus({}, () => {})),
      /réservé aux administrateurs du cerveau : votre jeton n'a pas les droits admin/,
    )
    station(brain.url, ADMIN)
    await assert.rejects(
      withPath(null, () => cmdRefreshStatus({}, () => {})),
      /Ni CLI `claude` dans le PATH ni clé API/,
    )
    assert.equal(brain.saved.length, 0)
  } finally {
    await brain.close()
  }
})

test("F-refresh-status : sans CLI mais avec une clé API, le SDK Anthropic rédige le résumé", async () => {
  const brain = await statusBrain()
  const status = { headline: "Résumé via l'API.", zones: [{ zone: "compta", summary: "Clôture en cours.", objectives: [], progress: "50 %", next_steps: [], who_did_what: [] }] }
  const anthropic = await mockServer((req) =>
    req.method === "POST" && req.url.startsWith("/v1/messages")
      ? {
          body: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [{ type: "text", text: JSON.stringify(status) }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
          },
        }
      : undefined,
  )
  const prevBase = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = anthropic.url
  try {
    station(brain.url, ADMIN, { anthropic_api_key: ["sk-ant-", "api03-", "t".repeat(30)].join("") })
    const l = logs()
    await withPath(null, () => cmdRefreshStatus({}, l.log))
    assert.equal(anthropic.requests.length, 1)
    assert.match(String((anthropic.requests[0].body as { messages: { content: string }[] }).messages[0].content), /Clôturer septembre/)
    assert.deepEqual(brain.saved, [{ headline: "Résumé via l'API.", zones: status.zones }])
    assert.match(l.text(), /Claude \(API Anthropic\)/)
  } finally {
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = prevBase
    await brain.close()
    await anthropic.close()
  }
})

test("F-claude-token : la distillation (claude -p) reçoit aussi CLAUDE_CODE_OAUTH_TOKEN", async () => {
  const brain = await mockServer((req) => {
    const path = req.url.split("?")[0]
    if (path === "/api/whoami") return { body: { org: { name: "F", description: "" }, profile: { id: "u", name: "Hugo" }, access: { isAdmin: false, readable: ["dev"], writable: ["dev"] }, context: null } }
    if (path === "/api/zones") return { body: { zones: TEST_ZONES } }
    if (path === "/api/ingest") return { status: 201, body: { inserted: 1, skipped: 0, ids: ["x"], zones: ["dev"] } }
    return undefined
  })
  const claude = fakeClaude()
  try {
    station(brain.url, MEMBER, { claude_oauth_token: CLAUDE_TOKEN, use_claude_cli: true })
    const proj = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "p")
    mkdirSync(proj, { recursive: true })
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
    writeFileSync(
      join(proj, "s.jsonl"),
      JSON.stringify({ type: "user", sessionId: "s", timestamp: at(30), message: { role: "user", content: "On part sur quelle base ?" } }) +
        "\n" +
        JSON.stringify({ type: "assistant", sessionId: "s", timestamp: at(29), message: { role: "assistant", content: [{ type: "text", text: "On part sur Supabase." }], stop_reason: "end_turn" } }) +
        "\n",
    )
    const out: string[] = []
    const r = await withPath(claude.bin, () => runSync({}, { log: (s) => out.push(s), warn: (s) => out.push(s) }))
    assert.equal(r.distiller, "claude-cli")
    assert.match(out.join("\n"), /jeton Claude Code de la config/)
    const calls = claude.calls()
    assert.ok(calls.length >= 1)
    for (const c of calls) {
      assert.equal(c.token, CLAUDE_TOKEN)
      assert.equal(c.internal, "1")
    }
    assert.ok(!out.join("\n").includes(CLAUDE_TOKEN))
    assert.equal(r.sent, 1)
  } finally {
    await brain.close()
  }
})

test("CLI : refresh-status et --claude-token dans l'aide ; refresh-status non admin → code 1 et message en français", async () => {
  const brain = await statusBrain()
  const claude = fakeClaude()
  try {
    const st = station(brain.url, MEMBER)
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
          cwd: clientDir,
          // PATH sans le dossier de node (la vraie CLI `claude` s'y trouve sur ce poste) : seule la fausse est visible.
          env: { HOME: tempDir(), PATH: `${claude.bin}${delimiter}/usr/bin${delimiter}/bin`, COMPANY_BRAIN_HOME: st.home },
        })
        let out = ""
        child.stdout.on("data", (d) => (out += d))
        child.stderr.on("data", (d) => (out += d))
        child.on("close", (code) => resolve({ code, out }))
      })
    const help = await run(["help"])
    assert.match(help.out, /refresh-status \[--dry-run\]/)
    assert.match(help.out, /--claude-token <jeton>/)
    const denied = await run(["refresh-status"])
    assert.equal(denied.code, 1)
    assert.match(denied.out, /réservé aux administrateurs du cerveau/)
    assert.ok(!denied.out.includes("at "), "pile d'appels affichée")
  } finally {
    await brain.close()
  }
})
