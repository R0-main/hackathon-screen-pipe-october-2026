import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { EXIT, JOIN_EXIT, buildInstallPrompt, buildJoinPrompt, installCommands } from "../../web/lib/install-prompt"
import { buildOnboardingAgentPrompt } from "../../web/lib/onboarding-agent"
import { EXIT_JOIN_PENDING, EXIT_JOIN_REJECTED } from "../src/join"
import { INSTALL_PROMPT_RE, maskOwnSecrets } from "../src/secrets"
import { EXIT_NO_SCREENPIPE, EXIT_PERMISSIONS_PENDING } from "../src/setup"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
const EXAMPLE = { baseUrl: "https://cerveau.example.com", token: "cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", name: "Jean-Marc Dubois", orgName: "Fournil", zones: ["compta"] }
const prompt = buildInstallPrompt(EXAMPLE)

test("prompt d'installation : une seule commande par système (install.sh ou install.ps1, puis setup), une seule autorisation dans Claude Code", () => {
  // Téléchargement raté : 5, jamais le code brut de curl (« curl: (6) » se lirait « branché sans Screenpipe »).
  const posix = `(curl -fsSL --create-dirs ${EXAMPLE.baseUrl}/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url ${EXAMPLE.baseUrl} --token ${EXAMPLE.token}`
  const windows =
    `New-Item -ItemType Directory -Force "$env:USERPROFILE\\.company-brain" | Out-Null; ` +
    `try { Invoke-WebRequest -UseBasicParsing ${EXAMPLE.baseUrl}/install.ps1 -OutFile "$env:USERPROFILE\\.company-brain\\install.ps1" -ErrorAction Stop } catch { exit 5 }; ` +
    `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\\.company-brain\\install.ps1" --url ${EXAMPLE.baseUrl} --token ${EXAMPLE.token}; exit $LASTEXITCODE`
  assert.ok(prompt.includes(`macOS, Linux, Git Bash : ${posix}\n`), "la commande macOS / Linux")
  assert.ok(prompt.includes(`Windows, PowerShell : ${windows}\n`), "la commande Windows")
  assert.deepEqual(installCommands(EXAMPLE.baseUrl, `--token ${EXAMPLE.token}`), { posix, windows })
  // Le jeton n'apparaît que dans ces deux commandes (une seule sera lancée).
  assert.equal(prompt.split(EXAMPLE.token).length, 3)
  assert.match(prompt, /Code 3 \(« EN ATTENTE »\)/)
  assert.match(prompt, /Code 5 : réseau ou adresse, relance la même commande/)
  assert.match(prompt, /brain doctor --json`, explique simplement chaque point KO et lance les corrections marquées « safe » \(même délai\)/)
  assert.match(prompt, /délai de 10 minutes/)
  // Ni prérequis à vérifier à la main ni étapes séparées : les scripts et setup s'en chargent.
  assert.ok(!/node -v|winget|install-schedule|install-hooks|claude mcp add/.test(prompt))
  // Deux commandes (macOS / Linux, Windows) et la consigne « session cloud » : court, mais pas plus.
  assert.ok(prompt.length < 2700, `prompt court (${prompt.length} caractères)`)
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

const JOIN = { baseUrl: "https://cerveau.example.com", code: "cj_XXXXXXXXXXXXXXXXXXXXXXXX", orgName: "Atelier Lumen" }
const joinPrompt = buildJoinPrompt(JOIN)

test("message d'équipe : une commande par système (install.sh ou install.ps1 --join), champs inconnus laissés à l'admin", () => {
  const options = `--join ${JOIN.code} --name "<prénom nom>" --title "<poste>" --email "<email>"`
  const cmd = installCommands(JOIN.baseUrl, options)
  assert.ok(joinPrompt.includes(`macOS, Linux, Git Bash : ${cmd.posix}\n`))
  assert.ok(joinPrompt.includes(`Windows, PowerShell : ${cmd.windows}\n`))
  assert.match(cmd.posix, /sh ~\/\.company-brain\/install\.sh --url https:\/\/cerveau\.example\.com --join cj_X+ --name "<prénom nom>"/)
  assert.equal(joinPrompt.split(JOIN.code).length, 3, "le code n'apparaît que dans les deux commandes")
  assert.match(joinPrompt, /N'invente rien/)
  assert.match(joinPrompt, /ne le transmets pas hors de l'entreprise/)
  assert.match(joinPrompt, /Code 7 \(« EN ATTENTE D'ACCEPTATION »\)/)
  assert.match(joinPrompt, /Code 8 : la demande a été refusée/)
  assert.match(joinPrompt, /Code 5 : réseau ou adresse, relance la même commande/)
  assert.match(joinPrompt, /brain doctor --json`/)
  assert.match(joinPrompt, /d'entreprise d'Atelier Lumen/, "élision")
  assert.ok(joinPrompt.length < 3000, `message court (${joinPrompt.length} caractères)`)
})

test("codes de sortie : un code, un sens, pour les scripts, setup et join", () => {
  assert.deepEqual(JOIN_EXIT, { pending: EXIT_JOIN_PENDING, rejected: EXIT_JOIN_REJECTED })
  assert.equal(EXIT.permissions, EXIT_PERMISSIONS_PENDING)
  assert.equal(EXIT.noScreenpipe, EXIT_NO_SCREENPIPE)
  const codes = Object.values(EXIT)
  assert.equal(new Set(codes).size, codes.length, "deux sens pour un même code")
  // Les scripts d'installation documentent le même tableau.
  for (const file of ["install.sh", "install.ps1"]) {
    const text = readFileSync(new URL(`../../web/public/${file}`, import.meta.url), "utf8")
    for (const c of [0, 1, 3, 6, 7, 8]) assert.match(text, new RegExp(`\\b${c} = `), `${file} : code ${c} non documenté`)
    assert.match(text, /\n#\s+2\s+mauvais appel/)
    assert.match(text, /\n#\s+5\s+t[ée]l[ée]chargement impossible/)
  }
})

test("message d'équipe : reconnu par brain-sync, et son code est masqué", () => {
  assert.ok(INSTALL_PROMPT_RE.test(joinPrompt))
  assert.ok(!maskOwnSecrets(joinPrompt).text.includes(JOIN.code))
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
