import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer as createHttpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { EXIT, JOIN_EXIT, buildInstallPrompt, buildJoinPrompt, installCommands, reinstallCommands } from "../../web/lib/install-prompt"
import { buildOnboardingAgentPrompt } from "../../web/lib/onboarding-agent"
import { EXIT_JOIN_PENDING, EXIT_JOIN_REJECTED } from "../src/join"
import { INSTALL_PROMPT_RE, maskOwnSecrets } from "../src/secrets"
import { EXIT_NO_SCREENPIPE, EXIT_PERMISSIONS_PENDING } from "../src/setup"

const clientDir = fileURLToPath(new URL("..", import.meta.url))
const installSh = fileURLToPath(new URL("../../web/public/install.sh", import.meta.url))
const EXAMPLE = { baseUrl: "https://brain.example.com", token: "cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", name: "Jean-Marc Dubois", orgName: "Fournil", zones: ["finance"] }
const prompt = buildInstallPrompt(EXAMPLE)

test("install prompt: a single command per system (install.sh or install.ps1, then setup), a single permission in Claude Code", () => {
  // Failed download: 5, never curl's raw code ("curl: (6)" would read as "connected without Screenpipe").
  const posix = `(curl -fsSL --create-dirs ${EXAMPLE.baseUrl}/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url ${EXAMPLE.baseUrl} --token ${EXAMPLE.token}`
  const windows =
    `New-Item -ItemType Directory -Force "$env:USERPROFILE\\.company-brain" | Out-Null; ` +
    `try { Invoke-WebRequest -UseBasicParsing ${EXAMPLE.baseUrl}/install.ps1 -OutFile "$env:USERPROFILE\\.company-brain\\install.ps1" -ErrorAction Stop } catch { exit 5 }; ` +
    `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\\.company-brain\\install.ps1" --url ${EXAMPLE.baseUrl} --token ${EXAMPLE.token}; exit $LASTEXITCODE`
  assert.ok(prompt.includes(`macOS, Linux, Git Bash: ${posix}\n`), "the macOS / Linux command")
  assert.ok(prompt.includes(`Windows, PowerShell: ${windows}\n`), "the Windows command")
  assert.deepEqual(installCommands(EXAMPLE.baseUrl, `--token ${EXAMPLE.token}`), { posix, windows })
  // The token only appears in these two commands (only one will be run).
  assert.equal(prompt.split(EXAMPLE.token).length, 3)
  assert.match(prompt, /Code 3 \("WAITING"\)/)
  assert.match(prompt, /Code 5: network or address, rerun the same command/)
  assert.match(prompt, /brain doctor --json`, explain each failing check simply and run the fixes marked "safe" \(same timeout\)/)
  assert.match(prompt, /10-minute timeout/)
  // No prerequisites to check by hand and no separate steps: the scripts and setup take care of them.
  assert.ok(!/node -v|winget|install-schedule|install-hooks|claude mcp add/.test(prompt))
  // Two commands (macOS / Linux, Windows) and the "cloud session" instruction: short, but no more.
  assert.ok(prompt.length < 2700, `short prompt (${prompt.length} characters)`)
})

test("install prompt: the exit codes quoted are those of setup and the scripts", () => {
  assert.equal(EXIT_PERMISSIONS_PENDING, 3)
  assert.equal(EXIT_NO_SCREENPIPE, 6)
  assert.match(prompt, new RegExp(`Code ${EXIT_PERMISSIONS_PENDING} \\("WAITING"\\)`))
  assert.match(prompt, new RegExp(`\\(${EXIT_NO_SCREENPIPE}: connected without Screenpipe\\)`))
})

test("install prompt: no history goes without a full review and explicit approval", () => {
  assert.match(prompt, /no history is sent/)
  const review = prompt.indexOf("brain sync --dry-run --full --since 24h")
  const send = prompt.indexOf("brain sync --confirm")
  assert.ok(review > 0 && send > review, "dry run reviewed before sending")
  assert.match(prompt, /nothing is sent\s+before my explicit approval/)
  assert.ok(!/brain sync --since/.test(prompt), "never a direct send")
})

test("install prompt: recognized by brain-sync (session ignored), old French wording included", () => {
  assert.ok(INSTALL_PROMPT_RE.test(prompt))
  // Prompts handed out before the English switch (intentional French).
  assert.ok(INSTALL_PROMPT_RE.test("Tu vas connecter ce poste au cerveau d'entreprise de Fournil. Je suis Jean-Marc Dubois."))
})

test("install prompt: every command and option quoted exists in the client", () => {
  const help = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "help"], { cwd: clientDir, encoding: "utf8" }).stdout
  const calls = [...prompt.matchAll(/company-brain\/brain ([a-z][a-z-]*)((?: --[a-z-]+(?: [^\s`-][^\s`]*)?)*)/g)]
  assert.ok(calls.length >= 5)
  for (const [, cmd, rest] of calls) {
    assert.ok(new RegExp(`^  ${cmd}\\b`, "m").test(help), `unknown command: ${cmd}`)
    for (const [flag] of rest.matchAll(/--[a-z-]+/g)) assert.ok(help.includes(flag), `unknown option: ${cmd} ${flag}`)
  }
})

test("install/PROMPT.md is up to date with buildInstallPrompt", () => {
  const md = readFileSync(new URL("../../../install/PROMPT.md", import.meta.url), "utf8")
  const example = md.match(/```text\n([\s\S]*?)\n```/)?.[1]
  assert.equal(example, prompt)
})

const JOIN = { baseUrl: "https://brain.example.com", code: "cj_XXXXXXXXXXXXXXXXXXXXXXXX", orgName: "Atelier Lumen" }
const joinPrompt = buildJoinPrompt(JOIN)

test("team message: one command per system (install.sh or install.ps1 --join), unknown fields left to the admin", () => {
  const options = `--join ${JOIN.code} --name "<first last>" --title "<role>" --email "<email>"`
  const cmd = installCommands(JOIN.baseUrl, options)
  assert.ok(joinPrompt.includes(`macOS, Linux, Git Bash: ${cmd.posix}\n`))
  assert.ok(joinPrompt.includes(`Windows, PowerShell: ${cmd.windows}\n`))
  assert.match(cmd.posix, /sh ~\/\.company-brain\/install\.sh --url https:\/\/brain\.example\.com --join cj_X+ --name "<first last>"/)
  assert.equal(joinPrompt.split(JOIN.code).length, 3, "the code only appears in the two commands")
  assert.match(joinPrompt, /Make nothing up/)
  assert.match(joinPrompt, /never pass it on outside the company/)
  assert.match(joinPrompt, /Code 7 \("WAITING FOR APPROVAL"\)/)
  assert.match(joinPrompt, /Code 8: the request was declined/)
  assert.match(joinPrompt, /Code 5: network or address, rerun the same command/)
  assert.match(joinPrompt, /brain doctor --json`/)
  assert.match(joinPrompt, /Atelier Lumen's company brain/, "possessive")
  assert.ok(joinPrompt.length < 3000, `short message (${joinPrompt.length} characters)`)
})

test("exit codes: one code, one meaning, for the scripts, setup and join", () => {
  assert.deepEqual(JOIN_EXIT, { pending: EXIT_JOIN_PENDING, rejected: EXIT_JOIN_REJECTED })
  assert.equal(EXIT.permissions, EXIT_PERMISSIONS_PENDING)
  assert.equal(EXIT.noScreenpipe, EXIT_NO_SCREENPIPE)
  const codes = Object.values(EXIT)
  assert.equal(new Set(codes).size, codes.length, "two meanings for the same code")
  // The install scripts document the same table.
  for (const file of ["install.sh", "install.ps1"]) {
    const text = readFileSync(new URL(`../../web/public/${file}`, import.meta.url), "utf8")
    for (const c of [0, 1, 3, 6, 7, 8]) assert.match(text, new RegExp(`\\b${c} = `), `${file}: code ${c} not documented`)
    assert.match(text, /\n#\s+2\s+bad call/)
    assert.match(text, /\n#\s+5\s+download impossible/)
  }
})

test("team message: recognized by brain-sync, and its code is redacted", () => {
  assert.ok(INSTALL_PROMPT_RE.test(joinPrompt))
  assert.ok(!maskOwnSecrets(joinPrompt).text.includes(JOIN.code))
})

test("onboarding prompt for an agent: reads the history, sends without applying anything, recognized and redacted by brain-sync", () => {
  const code = `co_${"Y".repeat(80)}`
  const p = buildOnboardingAgentPrompt({ baseUrl: "https://brain.example.com", code, orgName: "Atelier Lumen", zones: [{ id: "dev", name: "Dev" }] })
  assert.ok(INSTALL_PROMPT_RE.test(p))
  assert.ok(!maskOwnSecrets(p).text.includes(code))
  assert.equal(p.split(code).length, 2, "the code only appears once, in the command")
  assert.match(p, /~\/\.claude\/projects/)
  assert.match(p, /~\/\.codex\/sessions/)
  assert.match(p, /Never any secrets/)
  assert.match(p, /Nothing is applied: I review and validate/)
  const ask = p.indexOf("Do you agree to give this website access to that data?")
  assert.ok(ask > 0 && ask < p.indexOf("History: Claude Code"), "consent is asked before any reading")
  assert.match(p, /Without a clear yes, stop without reading or sending anything/)
  assert.match(p, /send brain\.example\.com/, "the receiving website is named")
  assert.ok(p.includes(`curl -fsS -X POST https://brain.example.com/api/onboarding/import -H "Authorization: Bearer ${code}"`))
})

test("prompts: a Claude Code session in the cloud stops instead of acting outside the computer", () => {
  for (const p of [prompt, joinPrompt, buildOnboardingAgentPrompt({ baseUrl: "https://brain.example.com", code: "co_x", orgName: "Fournil", zones: [] })]) {
    assert.match(p, /If you are not running on my computer \(cloud session, remote container\), stop/)
  }
})

test("onboarding prompt: framed by what the company does, to leave unrelated conversations aside", () => {
  const p = buildOnboardingAgentPrompt({
    baseUrl: "https://brain.example.com",
    code: "co_x",
    orgName: "Atelier Lumen",
    description: "Product design studio for healthcare startups.",
    zones: [],
  })
  assert.match(p, /The company is Atelier Lumen: "Product design studio for healthcare startups\."/)
  assert.match(p, /an unrelated conversation \(personal project, another company or another customer, a general question\) is left aside/)
  const noDescription = buildOnboardingAgentPrompt({ baseUrl: "https://brain.example.com", code: "co_x", orgName: "Orbite", zones: [] })
  assert.match(noDescription, /The company is Orbite\. Only keep what concerns it/)
})
const FP = "33483DC29874755818A10E941E52452421D5FF791FCF37578DB0E4EC570DF8F5"

test("install prompt, self-hosted brain: certificate fetched, fingerprint checked, then everything goes through it (macOS, Linux, Windows)", () => {
  const p = buildInstallPrompt({ ...EXAMPLE, caFingerprint: FP })
  const check = `[ "$(openssl x509 -in ~/.company-brain/ca.crt -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)" = "${FP}" ]`
  const posix =
    `mkdir -p ~/.company-brain && (curl -ksSL ${EXAMPLE.baseUrl}/ca.crt -o ~/.company-brain/ca.crt || exit 5) && (${check} || exit 9) && ` +
    `(curl -fsSL --cacert ~/.company-brain/ca.crt ${EXAMPLE.baseUrl}/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url ${EXAMPLE.baseUrl} --token ${EXAMPLE.token} --ca ~/.company-brain/ca.crt`
  const cmd = installCommands(EXAMPLE.baseUrl, `--token ${EXAMPLE.token}`, FP)
  assert.equal(cmd.posix, posix)
  assert.ok(p.includes(`macOS, Linux, Git Bash: ${posix}\n`), p)
  assert.ok(p.includes(`Windows, PowerShell: ${cmd.windows}\n`), "the Windows command")
  // Windows: the certificate is fetched without verification (PowerShell 5.1 and 7), checked with the same fingerprint (9 otherwise),
  // added to the user's store if it is not there, then install.ps1 is downloaded normally and receives --ca.
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
    assert.ok(i > at, `in order: ${part}`)
    at = i
  }
  assert.equal(w.split("SkipCertificateCheck").length, 2, "verification is only skipped to fetch the certificate")
  assert.equal(p.split(EXAMPLE.token).length, 3, "the token only appears in the two commands")
  assert.equal(p.split("curl -k").length, 2, "-k only serves to fetch the certificate, never for install.sh")
  assert.match(p, /code 9 = different fingerprint, stop and tell me/)
  assert.match(p, /On Windows, a dialog asks to confirm adding the certificate/)
  assert.ok(INSTALL_PROMPT_RE.test(p))
  assert.ok(p.length < 4500, `prompt (${p.length} characters)`)
  const j = buildJoinPrompt({ ...JOIN, caFingerprint: FP })
  assert.ok(j.includes(`(${check} || exit 9) && (curl -fsSL --cacert ~/.company-brain/ca.crt ${JOIN.baseUrl}/install.sh`))
  assert.ok(j.includes(`--join ${JOIN.code} --name "<first last>" --title "<role>" --email "<email>" --ca ~/.company-brain/ca.crt`))
  assert.ok(j.includes(`--join ${JOIN.code} --name "<first last>" --title "<role>" --email "<email>" --ca $ca; exit $LASTEXITCODE`))
  assert.ok(!prompt.includes("ca.crt") && !joinPrompt.includes("ca.crt"), "without a fingerprint (cloud): nothing changes")
  // From a computer already connected (brain doctor): the computer's certificate, no token, no new addition to the store.
  const again = reinstallCommands(EXAMPLE.baseUrl, "/Users/jm/.company-brain/ca.crt")
  assert.equal(again.posix, `(curl -fsSL --cacert "/Users/jm/.company-brain/ca.crt" --create-dirs ${EXAMPLE.baseUrl}/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url ${EXAMPLE.baseUrl} --ca "/Users/jm/.company-brain/ca.crt"`)
  const winAgain = reinstallCommands(EXAMPLE.baseUrl, "C:\\Users\\jm\\.company-brain\\ca.crt").windows
  assert.ok(winAgain.endsWith(`install.ps1" --url ${EXAMPLE.baseUrl} --ca "C:\\Users\\jm\\.company-brain\\ca.crt"; exit $LASTEXITCODE`), winAgain)
  assert.ok(!/certutil|--token/.test(winAgain))
  assert.deepEqual(reinstallCommands(EXAMPLE.baseUrl), installCommands(EXAMPLE.baseUrl))
})

test("install.sh --ca: brain.mjs downloaded with the certificate (private HTTPS), option passed to setup; refused without", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "brain-install-ca-"))
  const cert = join(dir, "cert.pem")
  const key = join(dir, "key.pem")
  const gen = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { encoding: "utf8" })
  if (gen.error || gen.status !== 0) return t.skip(`openssl unavailable (${gen.error?.message ?? gen.stderr.trim().split("\n")[0]})`)
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
    assert.notEqual(ko.status, 3, "without --ca, the private certificate is refused: nothing is started")
    const absent = await run(["--token", "cb_test", "--ca", join(dir, "absent.pem")])
    assert.equal(absent.status, 2)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
