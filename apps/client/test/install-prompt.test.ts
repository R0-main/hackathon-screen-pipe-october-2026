import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer as createHttpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { ABOUT_ORG_MAX, EXIT, JOIN_EXIT, buildInstallPrompt, buildJoinPrompt, installCommands, reinstallCommands } from "../../web/lib/install-prompt"
import { buildOnboardingAgentPrompt } from "../../web/lib/onboarding-agent"
import { EXIT_JOIN_PENDING, EXIT_JOIN_REJECTED } from "../src/join"
import { INSTALL_PROMPT_RE, maskOwnSecrets } from "../src/secrets"
import { EXIT_NO_SCREENPIPE, EXIT_PERMISSIONS_PENDING } from "../src/setup"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
const installSh = fileURLToPath(new URL("../../web/public/install.sh", import.meta.url))
const EXAMPLE = { baseUrl: "https://cerveau.example.com", token: "cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", name: "Jean-Marc Dubois", orgName: "Butine", zones: ["compta"] }
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
  assert.match(prompt, /brain doctor --json` et les corrections marquées « safe » \(même délai\), puis dis-moi en une phrase ce qui reste à faire/)
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
  assert.ok(joinPrompt.length < 3200, `message court (${joinPrompt.length} caractères)`)
})

test("prompts : l'entreprise présentée en deux mots quand elle a une description, rien sinon", () => {
  const about = "Butine fabrique des balances connectées pour ruches.\n6 personnes, basée à Lyon."
  const withAbout = buildInstallPrompt({ ...EXAMPLE, orgDescription: about })
  assert.ok(withAbout.startsWith("Tu vas connecter ce poste à NOS Brainer, le cerveau d'entreprise de Butine. L'entreprise, en deux mots : « Butine fabrique des balances connectées pour ruches. 6 personnes, basée à Lyon ». Je suis Jean-Marc Dubois"))
  assert.ok(INSTALL_PROMPT_RE.test(withAbout))
  const join = buildJoinPrompt({ ...JOIN, orgDescription: about })
  assert.match(join, /^Tu vas demander à rejoindre NOS Brainer, le cerveau d'entreprise d'Atelier Lumen\. L'entreprise, en deux mots : « Butine/)
  assert.ok(INSTALL_PROMPT_RE.test(join))
  for (const empty of [undefined, "", "  \n "]) {
    assert.equal(buildInstallPrompt({ ...EXAMPLE, orgDescription: empty }), prompt)
    assert.equal(buildJoinPrompt({ ...JOIN, orgDescription: empty }), joinPrompt)
  }
  // Une longue description est coupée au dernier mot entier.
  const long = buildInstallPrompt({ ...EXAMPLE, orgDescription: "ruche ".repeat(100) })
  const quoted = long.match(/« (.*?) »/)?.[1] ?? ""
  assert.ok(quoted.length <= ABOUT_ORG_MAX + 1 && quoted.endsWith("ruche…"), quoted)
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

test("prompts : une action bloquée se règle en une phrase, sans contourner ni lister d'options", () => {
  for (const p of [prompt, joinPrompt, buildOnboardingAgentPrompt({ baseUrl: "https://cerveau.example.com", code: "co_x", orgName: "Fournil", zones: [] })]) {
    assert.match(p, /Action bloquée ou refusée : ne contourne rien, dis-moi en une phrase quoi faire/)
    assert.match(p, /sans liste ni explication/)
  }
})

test("prompt d'onboarding : cadré par le nom et la description saisis, rien d'autre n'est appris", () => {
  const p = buildOnboardingAgentPrompt({
    baseUrl: "https://cerveau.example.com",
    code: "co_x",
    orgName: "Atelier Lumen",
    description: "Studio de design produit pour les start-up de la santé.",
    zones: [],
  })
  assert.match(
    p,
    /Tu cherches UNIQUEMENT les projets et les conversations de l'entreprise « Atelier Lumen », qui se décrit ainsi : « Studio de design produit pour les start-up de la santé\. »/,
  )
  assert.match(p, /n'apprends rien d'autre : un projet perso, une autre entreprise, un autre client, une question générale ou un autre sujet ne se lit pas en détail/)
  assert.match(p, /Dans le doute, laisse de côté\./)
  const sansDescription = buildOnboardingAgentPrompt({ baseUrl: "https://cerveau.example.com", code: "co_x", orgName: "Orbite", zones: [] })
  assert.match(sansDescription, /Tu cherches UNIQUEMENT les projets et les conversations de l'entreprise « Orbite »\. Repère d'abord/)
})
const FP = "57A3ACBF1A89EFD08B67BFA91AB261072FB73EC1C5A0102D2B6BF584C7201C49"

test("prompt d'installation, cerveau auto-hébergé : certificat récupéré, empreinte vérifiée, puis tout passe par lui (macOS, Linux, Windows)", () => {
  const p = buildInstallPrompt({ ...EXAMPLE, caFingerprint: FP })
  const check = `[ "$(openssl x509 -in ~/.company-brain/ca.crt -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)" = "${FP}" ]`
  const posix =
    `mkdir -p ~/.company-brain && (curl -ksSL ${EXAMPLE.baseUrl}/ca.crt -o ~/.company-brain/ca.crt || exit 5) && (${check} || exit 9) && ` +
    `(curl -fsSL --cacert ~/.company-brain/ca.crt ${EXAMPLE.baseUrl}/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url ${EXAMPLE.baseUrl} --token ${EXAMPLE.token} --ca ~/.company-brain/ca.crt`
  const cmd = installCommands(EXAMPLE.baseUrl, `--token ${EXAMPLE.token}`, FP)
  assert.equal(cmd.posix, posix)
  assert.ok(p.includes(`macOS, Linux, Git Bash : ${posix}\n`), p)
  assert.ok(p.includes(`Windows, PowerShell : ${cmd.windows}\n`), "la commande Windows")
  // Windows : le certificat est récupéré sans vérification (PowerShell 5.1 et 7), vérifié par la même empreinte (9 sinon),
  // ajouté au magasin de l'utilisateur s'il n'y est pas, puis install.ps1 est téléchargé normalement et reçoit --ca.
  const w = cmd.windows
  const order = [
    `$ca = "$env:USERPROFILE\\.company-brain\\ca.crt"; `,
    `if ($PSVersionTable.PSVersion.Major -ge 6) { $skip = @{ SkipCertificateCheck = $true } } else { [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } }; `,
    `try { Invoke-WebRequest -UseBasicParsing ${EXAMPLE.baseUrl}/ca.crt -OutFile $ca -ErrorAction Stop @skip } catch { exit 5 }; `,
    `[Net.ServicePointManager]::ServerCertificateValidationCallback = $null; `,
    `-replace '-') -ne '${FP}') { exit 9 }; `,
    `if (-not (Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object Thumbprint -eq $c.Thumbprint)) { certutil -user -addstore Root $ca | Out-Null }; `,
    `try { Invoke-WebRequest -UseBasicParsing ${EXAMPLE.baseUrl}/install.ps1 -OutFile "$env:USERPROFILE\\.company-brain\\install.ps1" -ErrorAction Stop } catch { exit 5 }; `,
    `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\\.company-brain\\install.ps1" --url ${EXAMPLE.baseUrl} --token ${EXAMPLE.token} --ca $ca; exit $LASTEXITCODE`,
  ]
  let at = -1
  for (const part of order) {
    const i = w.indexOf(part)
    assert.ok(i > at, `dans l'ordre : ${part}`)
    at = i
  }
  assert.equal(w.split("SkipCertificateCheck").length, 2, "la vérification n'est sautée que pour récupérer le certificat")
  assert.equal(p.split(EXAMPLE.token).length, 3, "le jeton n'apparaît que dans les deux commandes")
  assert.equal(p.split("curl -k").length, 2, "-k ne sert qu'à récupérer le certificat, jamais pour install.sh")
  assert.match(p, /code 9 = empreinte différente, arrête-toi et préviens-moi/)
  assert.match(p, /Sous Windows, une boîte de dialogue demande de confirmer l'ajout du certificat/)
  assert.ok(INSTALL_PROMPT_RE.test(p))
  assert.ok(p.length < 4500, `prompt (${p.length} caractères)`)
  const j = buildJoinPrompt({ ...JOIN, caFingerprint: FP })
  assert.ok(j.includes(`(${check} || exit 9) && (curl -fsSL --cacert ~/.company-brain/ca.crt ${JOIN.baseUrl}/install.sh`))
  assert.ok(j.includes(`--join ${JOIN.code} --name "<prénom nom>" --title "<poste>" --email "<email>" --ca ~/.company-brain/ca.crt`))
  assert.ok(j.includes(`--join ${JOIN.code} --name "<prénom nom>" --title "<poste>" --email "<email>" --ca $ca; exit $LASTEXITCODE`))
  assert.ok(!prompt.includes("ca.crt") && !joinPrompt.includes("ca.crt"), "sans empreinte (cloud) : rien ne change")
  // Depuis un poste déjà branché (brain doctor) : le certificat du poste, sans jeton, sans nouvel ajout au magasin.
  const again = reinstallCommands(EXAMPLE.baseUrl, "/Users/jm/.company-brain/ca.crt")
  assert.equal(again.posix, `(curl -fsSL --cacert "/Users/jm/.company-brain/ca.crt" --create-dirs ${EXAMPLE.baseUrl}/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url ${EXAMPLE.baseUrl} --ca "/Users/jm/.company-brain/ca.crt"`)
  const winAgain = reinstallCommands(EXAMPLE.baseUrl, "C:\\Users\\jm\\.company-brain\\ca.crt").windows
  assert.ok(winAgain.endsWith(`install.ps1" --url ${EXAMPLE.baseUrl} --ca "C:\\Users\\jm\\.company-brain\\ca.crt"; exit $LASTEXITCODE`), winAgain)
  assert.ok(!/certutil|--token/.test(winAgain))
  assert.deepEqual(reinstallCommands(EXAMPLE.baseUrl), installCommands(EXAMPLE.baseUrl))
})

test("install.sh --ca : brain.mjs téléchargé avec le certificat (HTTPS privé), option transmise à setup ; refusé sans", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "brain-install-ca-"))
  const cert = join(dir, "cert.pem")
  const key = join(dir, "key.pem")
  const gen = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { encoding: "utf8" })
  if (gen.error || gen.status !== 0) return t.skip(`openssl indisponible (${gen.error?.message ?? gen.stderr.trim().split("\n")[0]})`)
  const fake = "console.log(JSON.stringify(process.argv.slice(2))); process.exit(3)"
  const server = createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    if (req.url === "/brain.mjs") res.end(fake)
    else res.writeHead(404).end()
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  const run = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string }>((ok) => {
      const home = mkdtempSync(join(dir, "home-"))
      const child = spawn("sh", [installSh, "--url", url, ...args], { env: { ...process.env, COMPANY_BRAIN_HOME: home } })
      let stdout = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.on("close", (status) => ok({ status, stdout }))
    })
  try {
    const ok = await run(["--token", "cb_test", "--ca", cert])
    assert.equal(ok.status, 3, ok.stdout)
    assert.ok(ok.stdout.includes(JSON.stringify(["setup", "--url", url, "--token", "cb_test", "--ca", cert])), ok.stdout)
    const ko = await run(["--token", "cb_test"])
    assert.notEqual(ko.status, 3, "sans --ca, le certificat privé est refusé : rien n'est lancé")
    const absent = await run(["--token", "cb_test", "--ca", join(dir, "absent.pem")])
    assert.equal(absent.status, 2)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
