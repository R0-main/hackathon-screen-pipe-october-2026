import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import { promptFingerprint } from "@brain/core"
import { buildInstallPrompt } from "../../web/lib/install-prompt"
import type { Cache } from "../src/config"
import { eventForHook } from "../src/hook"
import { TEST_ZONES, mockServer, tempDir, type Recorded } from "./helpers"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
let srv: Awaited<ReturnType<typeof mockServer>>
let home: string

before(async () => {
  srv = await mockServer((req) => (req.url === "/api/events" ? { status: 201, body: { recorded: 1, zones: [] } } : undefined))
  home = tempDir()
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: srv.url, token: "cb_test_token_123456", screenpipe_url: "http://127.0.0.1:9", use_claude_cli: false, sources: ["claude"] }))
  writeFileSync(
    join(home, "cache.json"),
    JSON.stringify({
      updated_at: new Date().toISOString(),
      whoami: { name: "Hugo Bernard", org: "Fournil", role: "member", readable: ["dev"], writable: ["dev"] },
      zones: TEST_ZONES,
    }),
  )
})

after(() => srv.close())

// spawn asynchrone : le faux serveur tourne dans ce processus et doit pouvoir répondre.
function runHook(input: unknown, env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; ms: number }> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "hook"], {
      cwd: clientDir,
      env: { ...process.env, COMPANY_BRAIN_HOME: home, COMPANY_BRAIN_INTERNAL: "", ...env },
    })
    let stdout = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.on("close", (status) => resolve({ status, stdout, ms: Date.now() - t0 }))
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input))
  })
}

function lastEvent(): Recorded | undefined {
  return srv.requests.filter((r) => r.url === "/api/events").at(-1)
}

test("UserPromptSubmit : envoie zones + empreinte + résumé masqué, n'écrit rien sur stdout", async () => {
  const before = srv.requests.length
  const prompt = "Comment déployer la migration Supabase en production ? ma clé sk-ant-api03-abcdefghijklmnopqrstuvwxyz"
  const r = await runHook({ session_id: "sess-1", transcript_path: "/tmp/x.jsonl", cwd: "/w", hook_event_name: "UserPromptSubmit", prompt })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "")
  assert.equal(srv.requests.length, before + 1)
  const ev = lastEvent()!
  assert.equal(ev.headers.authorization, "Bearer cb_test_token_123456")
  const body = ev.body as Record<string, unknown>
  assert.equal(body.agent, "claude-code")
  assert.equal(body.type, "query")
  assert.deepEqual(body.zones, ["dev"])
  assert.equal(body.fingerprint, promptFingerprint(prompt))
  assert.equal(body.session_id, "sess-1")
  assert.ok(typeof body.summary === "string" && body.summary.length <= 160)
  assert.ok(!String(body.summary).includes("sk-ant"))
  assert.match(String(body.summary), /\[secret masqué\]/)
})

test("SessionStart : une seule ligne de contexte + événement started", async () => {
  const r = await runHook({ session_id: "sess-2", hook_event_name: "SessionStart", source: "startup" })
  assert.equal(r.status, 0)
  const lines = r.stdout.trim().split("\n")
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Cerveau d'entreprise de Fournil connecté/)
  assert.match(lines[0], /Dev/)
  assert.match(lines[0], /search_brain/)
  assert.match(lines[0], /company-brain/)
  assert.deepEqual(lastEvent()!.body, { agent: "claude-code", type: "started", session_id: "sess-2" })
})

test("Stop : événement stopped ; événement inconnu ignoré", async () => {
  await runHook({ session_id: "sess-3", hook_event_name: "Stop" })
  assert.deepEqual(lastEvent()!.body, { agent: "claude-code", type: "stopped", session_id: "sess-3" })
  const n = srv.requests.length
  const r = await runHook({ session_id: "sess-3", hook_event_name: "PreToolUse" })
  assert.equal(r.status, 0)
  assert.equal(srv.requests.length, n)
})

test("COMPANY_BRAIN_INTERNAL=1 : aucune requête, aucune sortie", async () => {
  const n = srv.requests.length
  const r = await runHook({ hook_event_name: "SessionStart" }, { COMPANY_BRAIN_INTERNAL: "1" })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "")
  assert.equal(srv.requests.length, n)
})

test("JSON invalide ou cerveau injoignable : code 0, rapide", async () => {
  assert.equal((await runHook("pas du json")).status, 0)
  const badHome = tempDir()
  writeFileSync(join(badHome, "config.json"), JSON.stringify({ url: "http://10.255.255.1:81", token: "cb_x" }))
  const r = await runHook({ hook_event_name: "UserPromptSubmit", prompt: "test" }, { COMPANY_BRAIN_HOME: badHome })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "")
  assert.ok(r.ms < 6000, `trop lent : ${r.ms} ms`)
})

const CACHE: Cache = { updated_at: "", zones: TEST_ZONES }
const prompt = (p: string) => ({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: p })

test("eventForHook : prompt perso → ni résumé, ni empreinte, ni zone (même classé par mot-clé)", () => {
  for (const p of [
    "REVIEWPRIV3 écris un message whatsapp à ma femme : je serai en retard ce soir",
    "réserve-moi un rdv doctolib pour mon fils, et vérifie la facture de la cantine",
    "Combien coûte une PS5 Pro ?",
  ]) {
    const ev = eventForHook(prompt(p), CACHE)!
    assert.deepEqual(ev, { agent: "claude-code", type: "query", zones: [], session_id: "s" }, p)
  }
})

test("eventForHook : prompt sans zone → empreinte seule, pas de résumé", () => {
  const p = "Quelle est la meilleure façon de structurer un tableau croisé ?"
  const ev = eventForHook(prompt(p), CACHE)!
  assert.deepEqual(ev.zones, [])
  assert.equal(ev.summary, undefined)
  assert.equal(ev.fingerprint, promptFingerprint(p))
})

test("eventForHook : prompt classé dans une zone → résumé masqué ; share_prompt_summaries=false → jamais de résumé", () => {
  const p = "Comment déployer la migration Supabase en production ?"
  const ev = eventForHook(prompt(p), CACHE)!
  assert.deepEqual(ev.zones, ["dev"])
  assert.equal(ev.summary, p)
  const off = eventForHook(prompt(p), CACHE, { shareSummaries: false })!
  assert.deepEqual(off.zones, ["dev"])
  assert.equal(off.summary, undefined)
  assert.equal(off.fingerprint, promptFingerprint(p))
})

test("eventForHook : prompt d'installation ou jeton du poste collé → rien du texte ne part", () => {
  const install = buildInstallPrompt({ baseUrl: "https://c.example", token: "cb_tqoelDcQG1aiU0jik075v5hdhINhmVhv", name: "Hugo", orgName: "Fournil", zones: ["dev"] })
  assert.deepEqual(eventForHook(prompt(install), CACHE), { agent: "claude-code", type: "query", zones: [], session_id: "s" })
  const pasted = "Le déploiement en production renvoie 401 avec mon jeton cb_tqoelDcQG1aiU0jik075v5hdhINhmVhv, pourquoi ?"
  assert.deepEqual(eventForHook(prompt(pasted), CACHE), { agent: "claude-code", type: "query", zones: [], session_id: "s" })
  const literal = "Le déploiement en production échoue avec la clé maclesecrete-123456789"
  assert.deepEqual(eventForHook(prompt(literal), CACHE, { secrets: ["maclesecrete-123456789"] }), { agent: "claude-code", type: "query", zones: [], session_id: "s" })
})

test("hook réel : share_prompt_summaries=false dans la config → événement sans résumé", async () => {
  const off = tempDir()
  writeFileSync(join(off, "config.json"), JSON.stringify({ url: srv.url, token: "cb_test_token_123456", share_prompt_summaries: false }))
  writeFileSync(join(off, "cache.json"), JSON.stringify({ updated_at: new Date().toISOString(), zones: TEST_ZONES }))
  const p = "Comment déployer la migration Supabase en production ?"
  const r = await runHook({ session_id: "sess-off", hook_event_name: "UserPromptSubmit", prompt: p }, { COMPANY_BRAIN_HOME: off })
  assert.equal(r.status, 0)
  const body = lastEvent()!.body as Record<string, unknown>
  assert.equal(body.session_id, "sess-off")
  assert.deepEqual(body.zones, ["dev"])
  assert.equal(body.summary, undefined)
  assert.equal(body.fingerprint, promptFingerprint(p))
})

test("hook réel : prompt perso → l'événement envoyé ne contient pas le texte", async () => {
  const p = "VRFPRIV1 écris un message whatsapp à ma femme : je serai en retard ce soir"
  await runHook({ session_id: "sess-perso", hook_event_name: "UserPromptSubmit", prompt: p })
  const ev = lastEvent()!
  assert.deepEqual(ev.body, { agent: "claude-code", type: "query", zones: [], session_id: "sess-perso" })
})

test("eventForHook : un secret configuré du poste (jeton Screenpipe, jeton Claude Code) n'est jamais envoyé, même non reconnaissable", () => {
  // Assemblés à l'exécution : aucun motif de secret en clair dans le dépôt.
  const spTok = ["sp", "-local-", "Kd83hQpz2Lm"].join("")
  const cache: Cache = { updated_at: "", zones: TEST_ZONES.map((z) => ({ ...z })) }
  const prompt = `Le déploiement de l'API en production échoue avec ${spTok} dans le code`
  // Prompt contenant un secret configuré : rien du texte ne part.
  const e = eventForHook({ hook_event_name: "UserPromptSubmit", prompt }, cache, { secrets: [spTok] })
  assert.deepEqual(e, { agent: "claude-code", type: "query", zones: [], session_id: undefined })
  // Sans le secret dans la liste, le texte passe par redact() : la valeur n'est pas reconnue comme un secret générique…
  const plain = eventForHook({ hook_event_name: "UserPromptSubmit", prompt }, cache, {})
  assert.ok(plain?.summary?.includes(spTok))
})
