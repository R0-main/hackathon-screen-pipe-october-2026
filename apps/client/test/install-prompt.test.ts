import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { buildInstallPrompt, installCommands } from "../../web/lib/install-prompt"
import { INSTALL_PROMPT_RE } from "../src/secrets"
import { EXIT_NO_SCREENPIPE, EXIT_PERMISSIONS_PENDING } from "../src/setup"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
const EXAMPLE = { baseUrl: "https://cerveau.example.com", token: "cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", name: "Jean-Marc Dubois", orgName: "Fournil", zones: ["compta"] }
const prompt = buildInstallPrompt(EXAMPLE)

test("prompt d'installation : une seule commande par système (install.sh ou install.ps1, puis setup), une seule autorisation dans Claude Code", () => {
  const posix = `curl -fsSL --create-dirs ${EXAMPLE.baseUrl}/install.sh -o ~/.company-brain/install.sh && sh ~/.company-brain/install.sh --url ${EXAMPLE.baseUrl} --token ${EXAMPLE.token}`
  const windows =
    `New-Item -ItemType Directory -Force "$env:USERPROFILE\\.company-brain" | Out-Null; Invoke-WebRequest -UseBasicParsing ${EXAMPLE.baseUrl}/install.ps1 -OutFile "$env:USERPROFILE\\.company-brain\\install.ps1"; ` +
    `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\\.company-brain\\install.ps1" --url ${EXAMPLE.baseUrl} --token ${EXAMPLE.token}`
  assert.ok(prompt.includes(`macOS, Linux, Git Bash : ${posix}\n`), "la commande macOS / Linux")
  assert.ok(prompt.includes(`Windows, PowerShell : ${windows}\n`), "la commande Windows")
  assert.deepEqual(installCommands(EXAMPLE.baseUrl, EXAMPLE.token), { posix, windows })
  // Le jeton n'apparaît que dans ces deux commandes (une seule sera lancée).
  assert.equal(prompt.split(EXAMPLE.token).length, 3)
  assert.match(prompt, /Code 3 \(« EN ATTENTE »\)/)
  assert.match(prompt, /Code 5 : réseau ou adresse, relance la même commande/)
  assert.match(prompt, /brain doctor --json`, explique simplement chaque point KO et lance les corrections marquées « safe »/)
  assert.match(prompt, /délai de 10 minutes/)
  // Ni prérequis à vérifier à la main ni étapes séparées : les scripts et setup s'en chargent.
  assert.ok(!/node -v|winget|install-schedule|install-hooks|claude mcp add/.test(prompt))
  assert.ok(prompt.length < 2400, `prompt court (${prompt.length} caractères)`)
})

test("prompt d'installation : les codes de sortie cités sont ceux de setup et des scripts", () => {
  assert.equal(EXIT_PERMISSIONS_PENDING, 3)
  assert.equal(EXIT_NO_SCREENPIPE, 6)
  assert.match(prompt, new RegExp(`Code ${EXIT_PERMISSIONS_PENDING} \\(« EN ATTENTE »\\)`))
  assert.match(prompt, new RegExp(`\\(${EXIT_NO_SCREENPIPE} : branché sans Screenpipe\\)`))
})

test("prompt d'installation : aucun historique ne part sans relecture complète et accord explicite", () => {
  assert.match(prompt, /aucun historique n'est envoyé/)
  const review = prompt.indexOf("brain sync --dry-run --full --since 24h")
  const send = prompt.indexOf("brain sync --confirm")
  assert.ok(review > 0 && send > review, "simulation relue avant l'envoi")
  assert.match(prompt, /rien ne part\s+avant mon accord explicite/)
  assert.ok(!/brain sync --since/.test(prompt), "jamais d'envoi direct")
})

test("prompt d'installation : reconnu par brain-sync (session ignorée), ancienne formulation comprise", () => {
  assert.ok(INSTALL_PROMPT_RE.test(prompt))
  assert.ok(INSTALL_PROMPT_RE.test("Tu vas connecter ce poste au cerveau d'entreprise de Fournil. Je suis Jean-Marc Dubois."))
})

test("prompt d'installation : chaque commande et option citée existe dans le client", () => {
  const help = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "help"], { cwd: clientDir, encoding: "utf8" }).stdout
  const calls = [...prompt.matchAll(/company-brain\/brain ([a-z][a-z-]*)((?: --[a-z-]+(?: [^\s`-][^\s`]*)?)*)/g)]
  assert.ok(calls.length >= 5)
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

const installSh = fileURLToPath(new URL("../../web/public/install.sh", import.meta.url))

test("install.sh : syntaxe POSIX valide, refuse un appel sans --url", () => {
  assert.equal(spawnSync("sh", ["-n", installSh]).status, 0)
  const r = spawnSync("sh", [installSh, "--token", "cb_x"], { encoding: "utf8" })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /Usage/)
})

test("install.sh : télécharge brain.mjs, écrit le raccourci, lance setup avec les mêmes options et rend son code", async () => {
  // Faux client : affiche ses arguments et sort en 3, comme setup quand une autorisation macOS manque.
  const fake = "console.log(JSON.stringify(process.argv.slice(2))); process.exit(3)"
  const server = createServer((req, res) => {
    if (req.url === "/brain.mjs") res.end(fake)
    else res.writeHead(404).end()
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const home = mkdtempSync(join(tmpdir(), "brain-install-"))
  try {
    const r = await new Promise<{ status: number | null; stdout: string }>((ok) => {
      const child = spawn("sh", [installSh, "--url", `${url}/`, "--token", "cb_test"], { env: { ...process.env, COMPANY_BRAIN_HOME: home } })
      let stdout = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.on("close", (status) => ok({ status, stdout }))
    })
    assert.equal(r.status, 3, "le code de setup est rendu tel quel")
    assert.ok(r.stdout.includes(JSON.stringify(["setup", "--url", `${url}/`, "--token", "cb_test"])), r.stdout)
    assert.equal(readFileSync(join(home, "brain.mjs"), "utf8"), fake)
    assert.ok(existsSync(join(home, "brain")), "raccourci ~/.company-brain/brain")
    const viaShortcut = spawnSync(join(home, "brain"), ["status"], { encoding: "utf8" })
    assert.equal(viaShortcut.stdout.trim(), JSON.stringify(["status"]))
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
