import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { buildInstallPrompt, buildJoinPrompt } from "../../web/lib/install-prompt"
import { buildOnboardingAgentPrompt } from "../../web/lib/onboarding-agent"
import { INSTALL_PROMPT_RE, maskOwnSecrets } from "../src/secrets"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
const EXAMPLE = { baseUrl: "https://cerveau.example.com", token: "cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", name: "Jean-Marc Dubois", orgName: "Fournil", zones: ["compta"] }
const prompt = buildInstallPrompt(EXAMPLE)

test("prompt d'installation : une seule commande (install.sh puis setup), une seule autorisation dans Claude Code", () => {
  const command = `curl -fsSL --create-dirs ${EXAMPLE.baseUrl}/install.sh -o ~/.company-brain/install.sh && sh ~/.company-brain/install.sh --url ${EXAMPLE.baseUrl} --token ${EXAMPLE.token}`
  assert.ok(prompt.includes(command), "la commande unique")
  assert.equal(prompt.split(EXAMPLE.token).length, 2, "le jeton n'apparaît qu'une fois, dans la commande")
  assert.match(prompt, /Code 3 \(« EN ATTENTE »\)/)
  assert.match(prompt, /délai de 10 minutes/)
  // Ni prérequis à vérifier à la main ni étapes séparées : install.sh et setup s'en chargent.
  assert.ok(!/node -v|install-schedule|install-hooks|claude mcp add/.test(prompt))
  assert.ok(prompt.length < 2000, `prompt court (${prompt.length} caractères)`)
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

const JOIN = { baseUrl: "https://cerveau.example.com", code: "cj_XXXXXXXXXXXXXXXXXXXXXXXX", orgName: "Atelier Lumen" }
const joinPrompt = buildJoinPrompt(JOIN)

test("message d'équipe : une seule commande (install.sh --join), champs inconnus laissés à l'admin", () => {
  assert.ok(joinPrompt.includes(`sh ~/.company-brain/install.sh --url ${JOIN.baseUrl} --join ${JOIN.code} --name "<prénom nom>"`))
  assert.equal(joinPrompt.split(JOIN.code).length, 2, "le code n'apparaît qu'une fois, dans la commande")
  assert.match(joinPrompt, /N'invente rien/)
  assert.match(joinPrompt, /ne le transmets pas hors de l'entreprise/)
  assert.match(joinPrompt, /Code 5 \(« EN ATTENTE D'ACCEPTATION »\)/)
  assert.match(joinPrompt, /d'entreprise d'Atelier Lumen/, "élision")
  assert.ok(joinPrompt.length < 2400, `message court (${joinPrompt.length} caractères)`)
})

test("message d'équipe : reconnu par brain-sync, et son code est masqué", () => {
  assert.ok(INSTALL_PROMPT_RE.test(joinPrompt))
  assert.ok(!maskOwnSecrets(joinPrompt).text.includes(JOIN.code))
})

test("install.sh --join : lance join (et non setup) avec les mêmes options", async () => {
  const fake = "console.log(JSON.stringify(process.argv.slice(2))); process.exit(5)"
  const server = createServer((req, res) => {
    if (req.url === "/brain.mjs") res.end(fake)
    else res.writeHead(404).end()
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const home = mkdtempSync(join(tmpdir(), "brain-install-"))
  try {
    const args = ["--url", url, "--join", "cj_test", "--name", "Léa Bernard"]
    const r = await new Promise<{ status: number | null; stdout: string }>((ok) => {
      const child = spawn("sh", [installSh, ...args], { env: { ...process.env, COMPANY_BRAIN_HOME: home } })
      let stdout = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.on("close", (status) => ok({ status, stdout }))
    })
    assert.equal(r.status, 5, "le code de join est rendu tel quel")
    assert.ok(r.stdout.includes(JSON.stringify(["join", ...args])), r.stdout)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test("prompt d'onboarding par un agent : lit l'historique, envoie sans rien appliquer, reconnu et masqué par brain-sync", () => {
  const code = `co_${"Y".repeat(80)}`
  const p = buildOnboardingAgentPrompt({ baseUrl: "https://cerveau.example.com", code, orgName: "Atelier Lumen", zones: [{ id: "dev", name: "Dev" }] })
  assert.ok(INSTALL_PROMPT_RE.test(p))
  assert.ok(!maskOwnSecrets(p).text.includes(code))
  assert.equal(p.split(code).length, 2, "le code n'apparaît qu'une fois, dans la commande")
  assert.match(p, /~\/\.claude\/projects/)
  assert.match(p, /~\/\.codex\/sessions/)
  assert.match(p, /Jamais de secrets/)
  assert.match(p, /Rien n'est appliqué : je relis et valide/)
  const ask = p.indexOf("Acceptes-tu de donner accès à ces données à ce site ?")
  assert.ok(ask > 0 && ask < p.indexOf("Historique : Claude Code"), "l'accord est demandé avant toute lecture")
  assert.match(p, /Sans un oui clair, arrête-toi sans rien lire ni envoyer/)
  assert.match(p, /envoyer à cerveau\.example\.com/, "le site qui reçoit est nommé")
  assert.ok(p.includes(`curl -fsS -X POST https://cerveau.example.com/api/onboarding/import -H "Authorization: Bearer ${code}"`))
})

test("prompts : une session Claude Code dans le cloud s'arrête au lieu d'agir hors du poste", () => {
  for (const p of [prompt, joinPrompt, buildOnboardingAgentPrompt({ baseUrl: "https://cerveau.example.com", code: "co_x", orgName: "Fournil", zones: [] })]) {
    assert.match(p, /Si tu ne tournes pas sur mon poste \(session cloud, conteneur distant\), arrête-toi/)
  }
})

test("prompt d'onboarding : cadré par ce que l'entreprise fait, pour laisser de côté les conversations sans rapport", () => {
  const p = buildOnboardingAgentPrompt({
    baseUrl: "https://cerveau.example.com",
    code: "co_x",
    orgName: "Atelier Lumen",
    description: "Studio de design produit pour les start-up de la santé.",
    zones: [],
  })
  assert.match(p, /L'entreprise, c'est Atelier Lumen : « Studio de design produit pour les start-up de la santé\. »/)
  assert.match(p, /une conversation sans rapport \(projet perso, autre entreprise ou autre client, question générale\) se laisse de côté/)
  const sansDescription = buildOnboardingAgentPrompt({ baseUrl: "https://cerveau.example.com", code: "co_x", orgName: "Orbite", zones: [] })
  assert.match(sansDescription, /L'entreprise, c'est Orbite\. Ne garde que ce qui la concerne/)
})
