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

test("prompt d'installation : une seule commande (téléchargement + setup), une seule autorisation dans Claude Code", () => {
  const command = `curl -fsSL --create-dirs ${EXAMPLE.baseUrl}/brain.mjs -o ~/.company-brain/brain.mjs && node ~/.company-brain/brain.mjs setup --url ${EXAMPLE.baseUrl} --token ${EXAMPLE.token}`
  assert.ok(prompt.includes(command), "la commande unique")
  assert.equal(prompt.split("setup --url").length, 2, "setup avec paramètres une seule fois ; ensuite, relance sans paramètres")
  assert.match(prompt, /code 3 \(« EN ATTENTE »\)/)
  assert.match(prompt, /délai de 10 minutes/)
  // La synchro planifiée part de l'installation ; pas d'étapes séparées à enchaîner.
  assert.ok(!/install-schedule|install-hooks|claude mcp add/.test(prompt))
})

test("prompt d'installation : aucun historique ne part sans relecture complète et accord explicite", () => {
  assert.match(prompt, /aucun historique n'est envoyé/)
  const review = prompt.indexOf("brain.mjs sync --dry-run --full --since 24h")
  const send = prompt.indexOf("brain.mjs sync --confirm")
  assert.ok(review > 0 && send > review, "simulation relue avant l'envoi")
  assert.match(prompt, /rien ne part\s+avant mon accord explicite/)
  assert.ok(!/brain\.mjs sync --since/.test(prompt), "jamais d'envoi direct")
})

test("prompt d'installation : reconnu par brain-sync (session ignorée), ancienne formulation comprise", () => {
  assert.ok(INSTALL_PROMPT_RE.test(prompt))
  assert.ok(INSTALL_PROMPT_RE.test("Tu vas connecter ce poste au cerveau d'entreprise de Fournil. Je suis Jean-Marc Dubois."))
})

test("prompt d'installation : chaque commande et option citée existe dans brain.mjs", () => {
  const help = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "help"], { cwd: clientDir, encoding: "utf8" }).stdout
  const calls = [...prompt.matchAll(/brain\.mjs ([a-z][a-z-]*)((?: --[a-z-]+(?: [^\s`-][^\s`]*)?)*)/g)]
  assert.ok(calls.length >= 6)
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
