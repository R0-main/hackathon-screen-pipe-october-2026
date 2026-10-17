// Fausse CLI `claude` (script Node) pour les tests : jamais la vraie. Chaque appel est journalisé (arguments, jeton,
// étiquettes QZX… du prompt) ; la réponse dépend du fichier `mode` (modifiable en cours de test) et du prompt.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { tempDir } from "./helpers"

export type FakeClaudeCall = { args: string[]; token: string | null; internal: string | null; simple: string | null; mode: string; tags: string[]; status: boolean }

/**
 * Modes : "" (normal), "expired" (jeton OAuth expiré, stderr, code 1), "revoked-json" (enveloppe is_error 401, code 1),
 * "login" (enveloppe is_error « Please run /login », code 0), "network" (Connection error), "weird" (même erreur inconnue
 * à chaque appel), "limit" (limite d'abonnement de la CLI actuelle : enveloppe is_error avec api_error_status 429, code 1),
 * "limit-text" (même limite, texte seul sur stderr, sans statut), "limit-ok" (le texte de la limite rendu comme une
 * réponse normale, is_error false, code 0). En mode normal : un prompt avec QZXBAD reçoit un refus en prose (sortie
 * illisible), un prompt avec QZXERR une erreur inconnue (code 1) ; sinon une décision par étiquette QZX… trouvée (zone dev).
 * `allow(n)` : les n prochains appels répondent normalement quel que soit le mode (limite atteinte en cours de synchro).
 * Agent Screenpipe (`--mcp-config` dans les arguments) : en mode normal, une connaissance de travail et une personnelle.
 */
export function fakeClaude(opts: { help?: string } = {}) {
  const dir = tempDir("fake-claude-")
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const script = `#!${process.execPath}
const fs = require("fs")
const dir = ${JSON.stringify(dir)}
if (process.argv[2] === "--help") { console.log(${JSON.stringify(opts.help ?? "--no-session-persistence --tools")}); process.exit(0) }
let input = ""
process.stdin.on("data", (d) => (input += d))
process.stdin.on("end", () => {
  let mode = ""
  try { mode = fs.readFileSync(dir + "/mode", "utf8").trim() } catch {}
  const tags = [...new Set(input.match(/QZX[A-Z]*\\d+/g) || [])]
  const status = input.includes('"headline"')
  fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify({ args: process.argv.slice(2), token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, internal: process.env.COMPANY_BRAIN_INTERNAL ?? null, simple: process.env.CLAUDE_CODE_SIMPLE ?? null, mode, tags, status }) + "\\n")
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
  // allow(n) : réponse normale tant que ce n'est pas plus que le n-ième appel depuis allow().
  let allowUntil = 0
  try { allowUntil = Number(fs.readFileSync(dir + "/allow", "utf8")) || 0 } catch {}
  if (fs.readFileSync(dir + "/calls.jsonl", "utf8").split("\\n").filter(Boolean).length <= allowUntil) mode = ""
  if (mode === "expired") { process.stderr.write("OAuth token has expired. Please obtain a new token or refresh your existing token.\\n"); process.exit(1) }
  if (mode === "revoked-json") { out({ type: "result", subtype: "success", is_error: true, duration_ms: 401, result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token revoked · Please run /login"}}' }); process.exit(1) }
  if (mode === "login") { out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }); return }
  if (mode === "network") { process.stderr.write("API Error: Connection error.\\n"); process.exit(1) }
  if (mode === "weird") { process.stderr.write("Erreur inattendue\\n"); process.exit(1) }
  const limit = "You've hit your session limit · resets 3pm"
  if (mode === "limit") { out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, duration_ms: 640, result: limit }); process.exit(1) }
  if (mode === "limit-text") { process.stderr.write("You've hit your weekly limit · resets Oct 20, 3pm\\n"); process.exit(1) }
  if (mode === "limit-ok") { out({ type: "result", subtype: "success", is_error: false, result: limit }); return }
  // Modérateur (brain moderate) : retire ce qui porte QZXPERSO, corrige ce qui porte QZXFIX, garde le reste.
  if (input.includes('{"verdicts"')) {
    const refs = [...input.matchAll(/<connaissance ref="(\\d+)"[^>]*>\\ntitle: ([^\\n]*)/g)].map((m) => ({ ref: Number(m[1]), title: m[2] }))
    const verdicts = refs.map(({ ref, title }) =>
      title.includes("QZXPERSO")
        ? { ref, decision: "reject", category: "personnel", reason: "Vie privée." }
        : title.includes("QZXFIX")
          ? { ref, decision: "edit", zone: "compta", title: "Titre corrigé" }
          : { ref, decision: "publish", category: null, reason: "ok" },
    )
    out({ type: "result", is_error: false, result: JSON.stringify({ verdicts }) })
    return
  }
  if (process.argv.includes("--mcp-config")) {
    const items = [
      { zone: "dev", kind: "fact", title: "Ticket FOUR-42 : litige facture Boulangerie Martin", body: "Le client conteste la facture 2026-118, relance prévue.", entities: [], confidence: 0.8 },
      { zone: "dev", kind: "fact", title: "Rendez-vous chez le médecin", body: "Mon arrêt maladie commence lundi.", entities: [], confidence: 0.8 },
    ]
    out({ type: "result", is_error: false, result: JSON.stringify({ items }) })
    return
  }
  if (/QZXBAD/.test(input)) { out({ type: "result", is_error: false, result: "Désolé, je préfère ne pas traiter cette conversation." }); return }
  if (/QZXERR/.test(input)) { process.stderr.write("Erreur inattendue\\n"); process.exit(1) }
  if (status) {
    const s = { headline: "Fournil avance.", zones: [{ zone: "dev", summary: "Supabase choisi.", objectives: [], progress: "En cours", next_steps: [], who_did_what: [] }] }
    out({ type: "result", is_error: false, result: JSON.stringify(s) })
    return
  }
  const items = tags.map((t) => ({ zone: "dev", kind: "decision", title: "Décision " + t, body: "On garde Supabase (" + t + ").", entities: [], confidence: 0.9 }))
  out({ type: "result", is_error: false, result: JSON.stringify({ items }) })
})
`
  writeFileSync(join(bin, "claude"), script)
  chmodSync(join(bin, "claude"), 0o755)
  return {
    bin,
    setMode: (mode: string) => writeFileSync(join(dir, "mode"), mode),
    allow: (n: number) => writeFileSync(join(dir, "allow"), String((existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).length : 0) + n)),
    calls: (): FakeClaudeCall[] =>
      existsSync(join(dir, "calls.jsonl"))
        ? readFileSync(join(dir, "calls.jsonl"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as FakeClaudeCall)
        : [],
  }
}

/** PATH limité à la fausse CLI et aux outils système (jamais la vraie `claude`, rangée près de node sur ce poste). */
export async function withPath<T>(bin: string | null, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PATH
  process.env.PATH = [bin, "/usr/bin", "/bin"].filter(Boolean).join(delimiter)
  try {
    return await fn()
  } finally {
    process.env.PATH = prev
  }
}
