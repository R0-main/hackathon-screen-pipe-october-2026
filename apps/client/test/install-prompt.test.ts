import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { buildInstallPrompt } from "../../web/lib/install-prompt"
import { INSTALL_PROMPT_RE } from "../src/secrets"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
const EXAMPLE = { baseUrl: "https://cerveau.example.com", token: "cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", name: "Jean-Marc Dubois", orgName: "Fournil", zones: ["compta"] }
const prompt = buildInstallPrompt(EXAMPLE)

test("prompt d'installation : init → hello → MCP / hooks → simulation complète + accord → envoi → seulement ensuite la planification", () => {
  const order = ["brain.mjs init --url", "brain.mjs hello", "claude mcp add company-brain", "brain.mjs install-hooks", "brain.mjs sync --dry-run --full", "brain.mjs sync --confirm", "brain.mjs install-schedule"]
  const at = order.map((s) => prompt.indexOf(s))
  for (const [n, i] of at.entries()) assert.ok(i >= 0, `absent : ${order[n]}`)
  assert.deepEqual([...at].sort((a, b) => a - b), at, "ordre des étapes")
  assert.match(prompt, /demande-moi explicitement si j'accepte cet envoi et attends ma réponse/)
  assert.match(prompt, /Si je refuse ou hésite : n'envoie rien et ne planifie rien/)
  // Plus d'envoi « sync --since » direct : seul --confirm envoie, exactement l'aperçu.
  assert.ok(!/brain\.mjs sync --since/.test(prompt))
})

test("prompt d'installation : reconnu par brain-sync (session ignorée)", () => {
  assert.ok(INSTALL_PROMPT_RE.test(prompt))
})

test("prompt d'installation : chaque commande et option citée existe dans brain.mjs", () => {
  const help = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "help"], { cwd: clientDir, encoding: "utf8" }).stdout
  const calls = [...prompt.matchAll(/brain\.mjs ([a-z-]+)((?: --[a-z-]+(?: [^\s`-][^\s`]*)?)*)/g)]
  assert.ok(calls.length >= 8)
  for (const [, cmd, rest] of calls) {
    assert.ok(new RegExp(`^  ${cmd}\\b`, "m").test(help), `commande inconnue : ${cmd}`)
    for (const [flag] of rest.matchAll(/--[a-z-]+/g)) assert.ok(help.includes(flag), `option inconnue : ${cmd} ${flag}`)
  }
})

test("install/PROMPT.md est à jour avec buildInstallPrompt", () => {
  const md = readFileSync(new URL("../../../install/PROMPT.md", import.meta.url), "utf8")
  const example = md.match(/```text\n([\s\S]*?)\n```/)?.[1]
  assert.equal(example, prompt)
})
