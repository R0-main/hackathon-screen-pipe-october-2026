// install.sh et install.ps1, les amorces servies par le dashboard (apps/web/public) : testées contre un faux serveur de
// cerveau, dans des dossiers temporaires (HOME et COMPANY_BRAIN_HOME), jamais dans le vrai dossier de l'utilisateur.
// Sans réseau, sauf BRAIN_TEST_NETWORK=1 : la copie privée de Node.js est alors vraiment téléchargée (~30 Mo).

import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { installCommands } from "../../web/lib/install-prompt"
import { tempDir } from "./helpers"

const publicDir = fileURLToPath(new URL("../../web/public/", import.meta.url))
const installSh = join(publicDir, "install.sh")
const installPs1 = join(publicDir, "install.ps1")
const NODE_VERSION = readFileSync(installSh, "utf8").match(/^NODE_VERSION="([^"]+)"/m)![1]
const NETWORK = process.env.BRAIN_TEST_NETWORK === "1"
const WIN = process.platform === "win32"
const POSIX_ONLY = { skip: WIN ? "POSIX seulement" : false }
const WIN_ONLY = { skip: WIN ? false : "Windows seulement" }
const TOKEN = "cb_TEST_tok3n_never_printed"

// --- Outils --------------------------------------------------------------------------------------------------------

type Run = { code: number | null; stdout: string; stderr: string }

/** Lance une commande, avec un minuteur qui la tue (60 s par défaut) : un script bloqué ne bloque pas la suite. */
function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; windowsVerbatimArguments?: boolean } = {}): Promise<Run> {
  return new Promise((ok, ko) => {
    const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, windowsHide: true, windowsVerbatimArguments: opts.windowsVerbatimArguments })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000)
    child.on("error", (err) => {
      clearTimeout(timer)
      ko(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      ok({ code, stdout, stderr })
    })
  })
}

const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore", timeout: 60_000 }).status === 0

/** Faux serveur du cerveau : sert les fichiers donnés, 404 pour le reste, et note les chemins demandés. */
async function brainServer(files: Record<string, { status?: number; body: string }>) {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? "/")
    const file = files[req.url ?? "/"]
    if (!file) return void res.writeHead(404).end("Not found")
    res.writeHead(file.status ?? 200, { "content-type": "text/plain; charset=utf-8" }).end(file.body)
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))),
  }
}

/** Faux client : affiche ses arguments et le dossier qu'il voit, puis sort avec le code donné (3 = autorisation en attente). */
const fakeClient = (code: number) =>
  `#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), home: process.env.COMPANY_BRAIN_HOME ?? null }))\nprocess.exit(${code})\n`
const HTML = "<!DOCTYPE html>\n<html><body>Connexion au Wi-Fi de l'hôtel</body></html>\n"

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** La ligne JSON écrite par le faux client. */
function clientOutput(stdout: string): { argv: string[]; home: string | null } {
  const line = stdout.split("\n").find((l) => l.startsWith('{"argv"'))
  assert.ok(line, `le faux client n'a pas tourné :\n${stdout}`)
  return JSON.parse(line)
}

// --- Postes de test POSIX ----------------------------------------------------------------------------------------

// Même règle qu'install.sh : un Node.js de gestionnaire de versions (ou x64 sur Apple Silicon) n'est pas retenu. Sur un
// tel poste de développement, les tests fournissent une fausse copie privée plutôt que de télécharger Node.js.
const VERSIONED = /\/(Cellar|\.nvm|fnm|\.fnm|\.volta|\.asdf|mise|\.nodenv|n\/versions|\.local\/share\/pnpm|pnpm\/nodejs)\/|^\/snap\//
const realNode = realpathSync(process.execPath)
const appleSilicon = process.platform === "darwin" && spawnSync("sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).stdout?.trim() === "1"
const systemNodeUsable = !WIN && !VERSIONED.test(realNode) && (!appleSilicon || process.arch === "arm64")
const realCurl = WIN ? "" : spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim()

/** Shells POSIX disponibles : install.sh doit marcher avec chacun. */
function shells(): string[][] {
  if (WIN) return []
  const list = [["sh"]]
  if (has("dash", ["-c", "exit 0"])) list.push(["dash"])
  if (has("bash", ["--posix", "-c", "exit 0"])) list.push(["bash", "--posix"])
  return list
}

function writeExec(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, 0o755)
}

/**
 * Un poste de test : HOME et COMPANY_BRAIN_HOME dans un dossier temporaire, et devant le PATH un curl espion qui note
 * chaque URL. nodejs.org y est bloqué, sauf ALLOW_NODEJS_ORG=1 : jamais de téléchargement de Node.js par surprise.
 */
function workstation(opts: { home?: (root: string) => string } = {}) {
  const root = tempDir("brain-install-")
  const home = opts.home ? opts.home(root) : join(root, "brain")
  const bin = join(root, "bin")
  writeExec(
    join(bin, "curl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/curl.log'
case "$*" in *nodejs.org*) [ "\${ALLOW_NODEJS_ORG:-}" = 1 ] || { echo "curl: nodejs.org bloqué par le test" >&2; exit 7; } ;; esac
exec '${realCurl}' "$@"
`,
  )
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ["SUDO_USER", "COMPANY_BRAIN_FORCE_PRIVATE_NODE", "COMPANY_BRAIN_HOME", "ALLOW_NODEJS_ORG"]) delete env[k]
  const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",")
  Object.assign(env, { HOME: root, COMPANY_BRAIN_HOME: home, PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter), no_proxy: noProxy, NO_PROXY: noProxy })
  return {
    root,
    home,
    bin,
    env,
    curlLog: () => (existsSync(join(root, "curl.log")) ? readFileSync(join(root, "curl.log"), "utf8") : ""),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
type Workstation = ReturnType<typeof workstation>

/** Faux Node.js privé : répond à la sonde d'install.sh (-p) avec la version voulue, passe tout le reste au vrai Node.js. */
function fakePrivateNode(home: string, version: string): string {
  const file = join(home, "node", "bin", "node")
  writeExec(file, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo "${version} ${process.arch} $0"; exit 0; fi\nexec '${process.execPath}' "$@"\n`)
  return file
}

/** Faux Node.js du système, rangé dans `dir` : sonde avec la version voulue ; ancien (< 20), il refuse tout le reste. */
function fakeSystemNode(dir: string, version: string, arch: string = process.arch): string {
  const file = join(dir, "node")
  const rest = Number(version.split(".")[0]) >= 20 ? `exec '${process.execPath}' "$@"` : `echo "node v${version} : trop ancien pour ce test" >&2; exit 1`
  writeExec(file, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo "${version} ${arch} $0"; exit 0; fi\n${rest}\n`)
  return file
}

/** Faux uname : système et processeur voulus (install.sh ne lit que -s et -m). */
function fakeUname(bin: string, system: string, machine: string) {
  writeExec(join(bin, "uname"), `#!/bin/sh\ncase "$1" in -m) echo ${machine} ;; *) echo ${system} ;; esac\n`)
}

/** Node.js sans téléchargement : celui du système s'il est retenu par install.sh, sinon une fausse copie privée figée. */
function withNode(ws: Workstation) {
  if (!systemNodeUsable) fakePrivateNode(ws.home, NODE_VERSION)
}

function installShell(shell: string[], args: string[], ws: Workstation, extra: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}) {
  return run(shell[0], [...shell.slice(1), installSh, ...args], { env: { ...ws.env, ...extra.env }, cwd: extra.cwd ?? ws.root, timeoutMs: extra.timeoutMs })
}
const install = (args: string[], ws: Workstation, extra: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}) => installShell(["sh"], args, ws, extra)

/** Lance le raccourci ~/.company-brain/brain sans COMPANY_BRAIN_HOME : il doit le fixer lui-même. */
function shortcut(ws: Workstation, args: string[], cwd = tmpdir()) {
  const env = { ...ws.env }
  delete env.COMPANY_BRAIN_HOME
  return run(join(ws.home, "brain"), args, { env, cwd })
}

function leftovers(home: string): string[] {
  return existsSync(home) ? readdirSync(home).filter((f) => /\.(new|tmp|download|old)\b|\.\d+$/.test(f)) : []
}

// --- install.sh ----------------------------------------------------------------------------------------------------

test("install.sh : syntaxe POSIX valide (sh, dash, bash --posix)", POSIX_ONLY, () => {
  for (const shell of shells()) {
    const r = spawnSync(shell[0], [...shell.slice(1), "-n", installSh], { encoding: "utf8" })
    assert.equal(r.status, 0, `${shell.join(" ")} -n : ${r.stderr}`)
  }
})

test("install.sh : mauvais appel → code 2, rien d'installé, le jeton jamais affiché", POSIX_ONLY, async () => {
  const ws = workstation()
  try {
    const cases: [string[], RegExp][] = [
      [["--token", TOKEN], /Usage/],
      [["--url", "ftp://cerveau.example.com", "--token", TOKEN], /https:\/\//],
      [["--url", "cerveau.example.com", "--token", TOKEN], /https:\/\//],
      [["--url", TOKEN], /https:\/\//],
    ]
    for (const [args, message] of cases) {
      const r = await install(args, ws)
      assert.equal(r.code, 2, `${args.join(" ")} : ${r.stderr}`)
      assert.match(r.stderr, message)
      assert.ok(!(r.stdout + r.stderr).includes(TOKEN), "jeton affiché")
    }
    // sudo : un faux `id` qui répond 0 (root) et SUDO_USER, comme sous sudo. Le script s'arrête avant toute écriture.
    writeExec(join(ws.bin, "id"), `#!/bin/sh\nif [ "$1" = "-u" ]; then echo 0; else exec /usr/bin/id "$@"; fi\n`)
    const sudo = await install(["--url", "https://cerveau.example.com", "--token", TOKEN], ws, { env: { SUDO_USER: "jean" } })
    assert.equal(sudo.code, 2, sudo.stderr)
    assert.match(sudo.stderr, /sans sudo/)
    assert.ok(!existsSync(ws.home), "rien n'est créé")
    assert.equal(ws.curlLog(), "", "rien n'est téléchargé")
  } finally {
    ws.cleanup()
  }
})

for (const shell of shells()) {
  test(`install.sh (${shell.join(" ")}) : télécharge brain.mjs, écrit le raccourci, lance setup avec les mêmes options et rend son code`, POSIX_ONLY, async () => {
    const srv = await brainServer({ "/brain.mjs": { body: fakeClient(3) } })
    const ws = workstation()
    withNode(ws)
    try {
      const r = await installShell(shell, ["--url", `${srv.url}/`, "--token", TOKEN, "--no-open"], ws)
      assert.equal(r.code, 3, `le code de setup est rendu tel quel\n${r.stdout}\n${r.stderr}`)
      assert.deepEqual(clientOutput(r.stdout), { argv: ["setup", "--url", `${srv.url}/`, "--token", TOKEN, "--no-open"], home: ws.home })
      const rest = r.stdout.split("\n").filter((l) => !l.startsWith('{"argv"')).join("\n") + r.stderr
      assert.ok(!rest.includes(TOKEN), "jeton affiché par install.sh")
      assert.equal(readFileSync(join(ws.home, "brain.mjs"), "utf8"), fakeClient(3))
      assert.equal(statSync(ws.home).mode & 0o777, 0o700, "dossier privé")
      assert.ok(statSync(join(ws.home, "brain")).mode & 0o100, "raccourci exécutable")
      assert.deepEqual(leftovers(ws.home), [])
      assert.equal(ws.curlLog().trim().split("\n").length, 1, `seul brain.mjs est téléchargé :\n${ws.curlLog()}`)
      assert.ok(ws.curlLog().includes(`${srv.url}/brain.mjs`))
      // Le raccourci marche d'ailleurs, sans COMPANY_BRAIN_HOME dans l'environnement : il le fixe lui-même.
      const s = await shortcut(ws, ["status"])
      assert.equal(s.code, 3)
      assert.deepEqual(clientOutput(s.stdout), { argv: ["status"], home: ws.home })
    } finally {
      ws.cleanup()
      await srv.close()
    }
  })
}

test("install.sh : --url=… marche aussi, et passe tel quel à setup", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(0) } })
  const ws = workstation()
  withNode(ws)
  try {
    const r = await install([`--url=${srv.url}`, "--token", TOKEN], ws)
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(clientOutput(r.stdout).argv, ["setup", `--url=${srv.url}`, "--token", TOKEN])
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh : brain.mjs introuvable (404) → code 5, message en français, rien d'installé", POSIX_ONLY, async () => {
  const srv = await brainServer({})
  const ws = workstation()
  withNode(ws)
  try {
    const r = await install(["--url", srv.url, "--token", TOKEN], ws)
    assert.equal(r.code, 5, r.stderr)
    assert.match(r.stderr, /Téléchargement impossible : http:\/\/127\.0\.0\.1:\d+\/brain\.mjs .*Relance la même commande/)
    assert.ok(!existsSync(join(ws.home, "brain.mjs")) && !existsSync(join(ws.home, "brain")))
    assert.deepEqual(leftovers(ws.home), [])
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh : une page HTML servie en 200 → code 5, l'ancien client et le raccourci restent intacts", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: HTML } })
  const ws = workstation()
  withNode(ws)
  try {
    mkdirSync(ws.home, { recursive: true })
    const oldClient = "// ancien client, qui marche\nconsole.log('ok')\n"
    const oldShortcut = "#!/bin/sh\necho ancien raccourci\n"
    writeFileSync(join(ws.home, "brain.mjs"), oldClient)
    writeExec(join(ws.home, "brain"), oldShortcut)
    const r = await install(["--url", srv.url, "--token", TOKEN], ws)
    assert.equal(r.code, 5, r.stderr)
    assert.match(r.stderr, /n'est pas le client du cerveau .*relance la même commande/)
    assert.equal(readFileSync(join(ws.home, "brain.mjs"), "utf8"), oldClient)
    assert.equal(readFileSync(join(ws.home, "brain"), "utf8"), oldShortcut)
    assert.deepEqual(leftovers(ws.home), [])
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh : dossier avec espace, apostrophe et $ → le raccourci marche et rien n'est interprété", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(0) } })
  const ws = workstation({ home: (root) => join(root, "Jean Marc's $(touch PWNED) `touch PWNED2` $HOME") })
  withNode(ws)
  try {
    const r = await install(["--url", srv.url, "--token", TOKEN], ws)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(clientOutput(r.stdout).home, ws.home)
    const s = await shortcut(ws, ["status"], ws.root)
    assert.equal(s.code, 0, s.stderr)
    assert.deepEqual(clientOutput(s.stdout), { argv: ["status"], home: ws.home })
    assert.ok(!existsSync(join(ws.root, "PWNED")) && !existsSync(join(ws.root, "PWNED2")), "le chemin a été interprété")
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh : COMPANY_BRAIN_HOME relatif devient absolu, pour setup comme pour le raccourci", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(0) } })
  const ws = workstation()
  try {
    const abs = join(ws.root, "dossier relatif", "brain")
    if (!systemNodeUsable) fakePrivateNode(abs, NODE_VERSION)
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env: { COMPANY_BRAIN_HOME: "dossier relatif/brain" }, cwd: ws.root })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(clientOutput(r.stdout).home, abs)
    const s = await run(join(abs, "brain"), ["status"], { env: { ...ws.env, COMPANY_BRAIN_HOME: undefined }, cwd: tmpdir() })
    assert.deepEqual(clientOutput(s.stdout), { argv: ["status"], home: abs })
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh : copie privée à la version figée → gardée, même avec un vieux node (v18) dans le PATH ; aucun téléchargement de Node.js", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(3) } })
  const ws = workstation()
  try {
    fakeSystemNode(join(ws.root, "old"), "18.20.4")
    const priv = fakePrivateNode(ws.home, NODE_VERSION)
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env: { PATH: [join(ws.root, "old"), ws.env.PATH].join(delimiter) } })
    assert.equal(r.code, 3, r.stderr)
    assert.ok(!ws.curlLog().includes("nodejs.org"), ws.curlLog())
    assert.match(readFileSync(join(ws.home, "brain"), "utf8"), new RegExp(`^exec '${esc(priv)}' `, "m"))
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh : Node.js trop ancien et nodejs.org injoignable → code 5, rien de cassé", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(0) } })
  const ws = workstation()
  try {
    fakeSystemNode(join(ws.root, "old"), "18.20.4")
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env: { PATH: [join(ws.root, "old"), ws.env.PATH].join(delimiter) } })
    assert.equal(r.code, 5, r.stderr)
    assert.match(r.stdout, /v18\.20\.4 .* trop ancien/)
    assert.match(r.stderr, new RegExp(`Téléchargement impossible : ${esc(`https://nodejs.org/dist/v${NODE_VERSION}/node-v`)}.*Relance la même commande`))
    assert.ok(!existsSync(join(ws.home, "node")) && !existsSync(join(ws.home, "brain.mjs")))
    assert.deepEqual(leftovers(ws.home), [])
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh : ancienne copie privée et téléchargement impossible → on la garde, avec un avertissement", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(3) } })
  const ws = workstation()
  try {
    fakePrivateNode(ws.home, "22.1.0")
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env: { COMPANY_BRAIN_FORCE_PRIVATE_NODE: "1" } })
    assert.equal(r.code, 3, r.stderr)
    assert.ok(ws.curlLog().includes("nodejs.org"), "la nouvelle version a été tentée")
    assert.match(r.stderr, /On continue avec la copie privée déjà installée \(Node\.js v22\.1\.0\)/)
    assert.ok(existsSync(join(ws.home, "node", "bin", "node")))
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh : Node.js d'un gestionnaire de versions (nvm) → copie privée tentée d'abord ; nvm seulement en dernier recours", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(0) } })
  const ws = workstation()
  try {
    const nvmBin = join(ws.root, ".nvm", "versions", "node", "v22.9.0", "bin")
    const nvmNode = fakeSystemNode(nvmBin, "22.9.0")
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env: { PATH: [nvmBin, ws.env.PATH].join(delimiter) } })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /gestionnaire de versions/)
    assert.ok(ws.curlLog().includes("nodejs.org"), "la copie privée a été tentée avant nvm")
    assert.ok(r.stderr.includes(`On continue avec ${nvmNode}`), r.stderr)
    assert.match(readFileSync(join(ws.home, "brain"), "utf8"), new RegExp(`^exec '${esc(nvmNode)}' `, "m"))
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh : Node.js du système → le raccourci garde son vrai chemin, pas celui du lien ou du shim", { skip: systemNodeUsable ? false : "Node.js de ce poste écarté par install.sh (gestionnaire de versions)" }, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(0) } })
  const ws = workstation()
  try {
    const shim = join(ws.root, "shim")
    mkdirSync(shim)
    symlinkSync(process.execPath, join(shim, "node"))
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env: { PATH: [shim, ws.env.PATH].join(delimiter) } })
    assert.equal(r.code, 0, r.stderr)
    const text = readFileSync(join(ws.home, "brain"), "utf8")
    assert.match(text, new RegExp(`^exec '${esc(realNode)}' `, "m"))
    assert.ok(!text.includes(shim))
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh : Linux musl (Alpine) → archive officielle linux-x64-musl ; musl sur ARM → code 4 avec la commande apk", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(0) } })
  const ws = workstation()
  try {
    writeExec(join(ws.bin, "ldd"), `#!/bin/sh\necho "musl libc (x86_64)" >&2\nexit 1\n`)
    const env = { COMPANY_BRAIN_FORCE_PRIVATE_NODE: "1" }
    fakeUname(ws.bin, "Linux", "x86_64")
    const x64 = await install(["--url", srv.url, "--token", TOKEN], ws, { env })
    assert.equal(x64.code, 5, x64.stderr)
    assert.ok(ws.curlLog().includes(`node-v${NODE_VERSION}-linux-x64-musl.tar.gz`), ws.curlLog())
    fakeUname(ws.bin, "Linux", "aarch64")
    const arm = await install(["--url", srv.url, "--token", TOKEN], ws, { env })
    assert.equal(arm.code, 4, arm.stderr)
    assert.match(arm.stderr, /apk add nodejs npm/)
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh : Mac Apple Silicon sous Rosetta → Node.js x64 écarté, archive darwin-arm64", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(0) } })
  const ws = workstation()
  try {
    // Sous Rosetta, uname -m dit x86_64 mais hw.optional.arm64 vaut 1.
    fakeUname(ws.bin, "Darwin", "x86_64")
    writeExec(join(ws.bin, "sysctl"), `#!/bin/sh\n[ "$2" = hw.optional.arm64 ] && echo 1\n`)
    const rosetta = join(ws.root, "usr-local-bin")
    fakeSystemNode(rosetta, "22.9.0", "x64")
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env: { PATH: [rosetta, ws.env.PATH].join(delimiter) } })
    assert.equal(r.code, 5, r.stderr)
    assert.match(r.stdout, /en x64 \(Rosetta\)/)
    assert.ok(ws.curlLog().includes(`node-v${NODE_VERSION}-darwin-arm64.tar.gz`), ws.curlLog())
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh sous Windows (Git Bash) : télécharge install.ps1 et lui passe la main, code rendu tel quel", POSIX_ONLY, async () => {
  const ps1 = readFileSync(installPs1, "utf8")
  const srv = await brainServer({ "/install.ps1": { body: ps1 } })
  const ws = workstation()
  try {
    // Faux Git Bash : uname de MINGW, cygpath qui marque les chemins Windows « W: », powershell.exe qui affiche ce qu'il reçoit.
    writeExec(join(ws.bin, "uname"), "#!/bin/sh\necho MINGW64_NT-10.0-26100\n")
    writeExec(join(ws.bin, "cygpath"), `#!/bin/sh\ncase "$1" in -u) printf '%s\\n' "$2" ;; -w) printf 'W:%s\\n' "$2" ;; esac\n`)
    writeFileSync(
      join(ws.root, "fake-ps.js"),
      "const e = process.env\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), msys: e.MSYS_NO_PATHCONV, conv: e.MSYS2_ARG_CONV_EXCL, home: e.COMPANY_BRAIN_HOME }))\nprocess.exit(6)\n",
    )
    writeExec(join(ws.bin, "powershell.exe"), `#!/bin/sh\nexec '${process.execPath}' '${join(ws.root, "fake-ps.js")}' "$@"\n`)
    const r = await install(["--url", srv.url, "--token", TOKEN], ws)
    assert.equal(r.code, 6, r.stderr)
    const line = JSON.parse(r.stdout.split("\n").find((l) => l.startsWith('{"argv"'))!)
    assert.deepEqual(line, {
      argv: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `W:${ws.home}/install.ps1`, "--url", srv.url, "--token", TOKEN],
      msys: "1",
      conv: "*",
      home: `W:${ws.home}`,
    })
    assert.equal(readFileSync(join(ws.home, "install.ps1"), "utf8"), ps1)
    assert.deepEqual(leftovers(ws.home), [])
    assert.ok(!existsSync(join(ws.home, "brain.mjs")), "le travail est fait par install.ps1")

    // Une page HTML à la place d'install.ps1 : code 5, jamais exécutée.
    const html = await brainServer({ "/install.ps1": { body: HTML } })
    try {
      const h = await install(["--url", html.url, "--token", TOKEN], ws)
      assert.equal(h.code, 5, h.stderr)
      assert.match(h.stderr, /n'est pas le script d'installation/)
      assert.equal(readFileSync(join(ws.home, "install.ps1"), "utf8"), ps1)
    } finally {
      await html.close()
    }
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh : copie privée de Node.js vraiment téléchargée et vérifiée (BRAIN_TEST_NETWORK=1)", { skip: WIN ? "POSIX seulement" : NETWORK ? false : "BRAIN_TEST_NETWORK=1 pour télécharger Node.js" }, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(3) } })
  const ws = workstation()
  try {
    // Une ancienne copie privée en place : la nouvelle la remplace (échange sans perte).
    fakePrivateNode(ws.home, "22.1.0")
    const env = { COMPANY_BRAIN_FORCE_PRIVATE_NODE: "1", ALLOW_NODEJS_ORG: "1" }
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env, timeoutMs: 300_000 })
    assert.equal(r.code, 3, `${r.stdout}\n${r.stderr}`)
    const priv = join(ws.home, "node", "bin", "node")
    assert.equal(spawnSync(priv, ["-p", "process.versions.node"], { encoding: "utf8" }).stdout.trim(), NODE_VERSION)
    assert.deepEqual(clientOutput(r.stdout).argv, ["setup", "--url", srv.url, "--token", TOKEN])
    assert.match(readFileSync(join(ws.home, "brain"), "utf8"), new RegExp(`^exec '${esc(priv)}' `, "m"))
    assert.deepEqual(leftovers(ws.home), [])
    // Relancé : la copie privée à la version figée est gardée, sans nouveau téléchargement.
    const again = await install(["--url", srv.url, "--token", TOKEN], ws, { env })
    assert.equal(again.code, 3, again.stderr)
    assert.equal(ws.curlLog().split("\n").filter((l) => l.includes("nodejs.org")).length, 1)
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

// --- install.ps1 ---------------------------------------------------------------------------------------------------

test("install.ps1 : ASCII pur (Windows PowerShell 5.1 lit un .ps1 sans BOM en ANSI) et commence par la marque vérifiée par install.sh", () => {
  const bytes = readFileSync(installPs1)
  const bad = [...bytes].findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09))
  assert.equal(bad, -1, `caractère non ASCII à l'octet ${bad} : ${bytes.subarray(Math.max(0, bad - 40), bad + 10).toString("latin1")}`)
  assert.ok(bytes.toString("ascii").startsWith("# NOS Brainer"))
})

/** PowerShell disponibles sur ce poste : pwsh (7) partout, powershell.exe (5.1) sous Windows. */
const powershells = [...(has("pwsh", ["-NoProfile", "-Command", "exit 0"]) ? ["pwsh"] : []), ...(WIN && has("powershell.exe", ["-NoProfile", "-Command", "exit 0"]) ? ["powershell.exe"] : [])]

test("install.ps1 : analysé sans erreur par PowerShell", { skip: powershells.length ? false : "ni pwsh ni powershell.exe" }, () => {
  const path = installPs1.replace(/'/g, "''")
  for (const ps of powershells) {
    const script = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$null, [ref]$e); $e | ForEach-Object { $_.ToString() }; exit $e.Count`
    const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 60_000 })
    assert.equal(r.status, 0, `${ps} : ${r.stdout}${r.stderr}`)
  }
})

/** install.ps1 lancé comme par le prompt : powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 <options>. */
function installPs(ps: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs?: number) {
  return run(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installPs1, ...args], { env, timeoutMs })
}

function psEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, COMPANY_BRAIN_HOME: home, ...extra }
  for (const k of ["COMPANY_BRAIN_FORCE_PRIVATE_NODE", "SUDO_USER"]) if (!(k in extra)) delete env[k]
  const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",")
  return { ...env, no_proxy: noProxy, NO_PROXY: noProxy }
}

// Hors Windows, pwsh exécute la même logique (arguments, adresse, téléchargement, vérification, raccourcis) avec le
// Node.js du système : de quoi tester install.ps1 sur la CI Linux. Ce qui est propre à Windows est testé plus bas.
const pwshHere = !WIN && powershells.includes("pwsh") && systemNodeUsable
test("install.ps1 (pwsh hors Windows) : options, --url= recollé, code de setup rendu, raccourcis ; HTML → 5 ; sans --url → 2", { skip: pwshHere ? false : "pwsh absent, ou Windows" }, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(3) } })
  const root = tempDir("brain-install-ps-")
  const home = join(root, "brain home")
  // Le Node.js qui fait tourner ces tests d'abord dans le PATH : c'est lui qu'install.ps1 doit retenir.
  const env = psEnv(home, { PATH: [dirname(process.execPath), process.env.PATH].join(delimiter) })
  try {
    // "--url=http://…" : powershell -File le coupe en deux ; install.ps1 doit le recoller, pour lui comme pour setup.
    const r = await installPs("pwsh", [`--url=${srv.url}/`, "--token", TOKEN, "--wait", "300"], env)
    assert.equal(r.code, 3, `${r.stdout}\n${r.stderr}`)
    assert.deepEqual(clientOutput(r.stdout), { argv: ["setup", `--url=${srv.url}/`, "--token", TOKEN, "--wait", "300"], home })
    assert.ok(!(r.stdout.split("\n").filter((l) => !l.startsWith('{"argv"')).join("\n") + r.stderr).includes(TOKEN), "jeton affiché")
    const cmd = readFileSync(join(home, "brain.cmd"), "latin1")
    assert.equal(cmd, `@setlocal\r\n@set "COMPANY_BRAIN_HOME=${home}"\r\n@"${realNode}" "%~dp0brain.mjs" %*\r\n`)
    const s = await run("sh", [join(home, "brain"), "status"], { env: { ...process.env, COMPANY_BRAIN_HOME: undefined }, cwd: tmpdir() })
    assert.deepEqual(clientOutput(s.stdout), { argv: ["status"], home })
    assert.deepEqual(leftovers(home), [])

    const html = await brainServer({ "/brain.mjs": { body: HTML } })
    try {
      const h = await installPs("pwsh", ["--url", html.url, "--token", TOKEN], env)
      assert.equal(h.code, 5, h.stderr)
      assert.match(h.stderr, /n'est pas le client du cerveau/)
      assert.equal(readFileSync(join(home, "brain.mjs"), "utf8"), fakeClient(3), "l'ancien client reste intact")
    } finally {
      await html.close()
    }
    const usage = await installPs("pwsh", ["--token", TOKEN], env)
    assert.equal(usage.code, 2)
    assert.match(usage.stderr, /Usage/)
    const bad = await installPs("pwsh", ["--url", "ftp://x", "--token", TOKEN], env)
    assert.equal(bad.code, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
    await srv.close()
  }
})

/**
 * La ligne Windows du prompt, telle quelle, passée à `powershell -Command` comme par l'outil PowerShell de Claude Code :
 * le code de setup doit remonter (3, 6), et un téléchargement raté donner 5. Hors Windows (pwsh), « \\ » n'est pas un
 * séparateur de chemin : remplacé par « / » pour l'essai, et `powershell` par `pwsh`.
 */
async function promptLine(ps: string, files: Record<string, { status?: number; body: string }>): Promise<Run> {
  const srv = await brainServer(files)
  const profile = tempDir("brain-prompt-ps-")
  try {
    let line = installCommands(srv.url, TOKEN).windows
    if (!WIN) line = line.replace(/\\/g, "/").replace(/\bpowershell -NoProfile/, `${ps} -NoProfile`)
    const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: profile }
    delete env.COMPANY_BRAIN_HOME
    const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",")
    return await run(ps, ["-NoProfile", "-Command", line], { env: { ...env, no_proxy: noProxy, NO_PROXY: noProxy, PATH: [dirname(process.execPath), process.env.PATH].join(delimiter) }, timeoutMs: 120_000 })
  } finally {
    rmSync(profile, { recursive: true, force: true })
    await srv.close()
  }
}

const promptShell = WIN ? (powershells.includes("powershell.exe") ? "powershell.exe" : "") : pwshHere ? "pwsh" : ""
test("ligne Windows du prompt : code de setup rendu tel quel, téléchargement raté → 5, jeton jamais affiché", { skip: promptShell ? false : "ni powershell.exe (Windows) ni pwsh" }, async () => {
  const ps1 = { body: readFileSync(installPs1, "utf8") }
  for (const code of [0, 3, 6]) {
    const r = await promptLine(promptShell, { "/install.ps1": ps1, "/brain.mjs": { body: fakeClient(code) } })
    assert.equal(r.code, code, `${r.stdout}\n${r.stderr}`)
    assert.ok(!(r.stdout.split("\n").filter((l) => !l.startsWith('{"argv"')).join("\n") + r.stderr).includes(TOKEN), "jeton affiché")
  }
  const missing = await promptLine(promptShell, { "/brain.mjs": { body: fakeClient(0) } })
  assert.equal(missing.code, 5, `${missing.stdout}\n${missing.stderr}`)
})

// --- Windows -------------------------------------------------------------------------------------------------------

/** Lance brain.cmd par cmd, comme depuis un terminal Windows. */
function runCmd(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return run("cmd.exe", ["/d", "/s", "/c", `""${file}" ${args.join(" ")}"`], { env, windowsVerbatimArguments: true })
}

test("install.ps1 (Windows) : --url= recollé, brain.cmd et brain écrits, setup lancé avec les mêmes options, code rendu ; brain.cmd marche par cmd", WIN_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(3) } })
  const home = join(tempDir("brain-install-win-"), "brain")
  try {
    // Forme --url= : Windows PowerShell 5.1 coupe aussi "-nom:valeur" ; install.ps1 doit recoller l'adresse.
    const r = await installPs("powershell.exe", [`--url=${srv.url}`, "--token", TOKEN, "--no-open"], psEnv(home))
    assert.equal(r.code, 3, `${r.stdout}\n${r.stderr}`)
    assert.deepEqual(clientOutput(r.stdout), { argv: ["setup", `--url=${srv.url}`, "--token", TOKEN, "--no-open"], home })
    assert.ok(existsSync(join(home, "brain.cmd")) && existsSync(join(home, "brain")))
    assert.match(readFileSync(join(home, "brain"), "utf8"), /^#!\/bin\/sh\n[\s\S]*exec '\/[a-z]\/[^\n]*' "\$@"\n$/)
    const s = await runCmd(join(home, "brain.cmd"), ["status"], { ...process.env, COMPANY_BRAIN_HOME: undefined })
    assert.equal(s.code, 3, s.stderr)
    assert.deepEqual(clientOutput(s.stdout), { argv: ["status"], home })
    assert.deepEqual(leftovers(home), [])
  } finally {
    rmSync(dirname(home), { recursive: true, force: true })
    await srv.close()
  }
})

test("install.ps1 (Windows) : page HTML au lieu du client → code 5, l'ancien client reste intact", WIN_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: HTML } })
  const home = join(tempDir("brain-install-win-"), "brain")
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "brain.mjs"), "// ancien client\n")
    const r = await installPs("powershell.exe", ["--url", srv.url, "--token", TOKEN], psEnv(home))
    assert.equal(r.code, 5, `${r.stdout}\n${r.stderr}`)
    assert.equal(readFileSync(join(home, "brain.mjs"), "utf8"), "// ancien client\n")
  } finally {
    rmSync(dirname(home), { recursive: true, force: true })
    await srv.close()
  }
})

const gitBash = WIN ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe") : ""
test("install.sh dans Git Bash (Windows) : passe la main à install.ps1 et rend le code de setup", { skip: WIN ? (existsSync(gitBash) ? false : "Git Bash absent") : "Windows seulement" }, async () => {
  const ps1 = readFileSync(installPs1, "utf8")
  const srv = await brainServer({ "/install.ps1": { body: ps1 }, "/brain.mjs": { body: fakeClient(3) } })
  const root = tempDir("brain-install-gitbash-")
  const home = join(root, "brain")
  try {
    // Copie en fins de ligne LF : un dépôt extrait avec core.autocrlf=true donnerait un install.sh illisible par sh.
    const sh = join(root, "install.sh")
    writeFileSync(sh, readFileSync(installSh, "utf8").replace(/\r\n/g, "\n"))
    const r = await run(gitBash, [sh.replace(/\\/g, "/"), "--url", srv.url, "--token", TOKEN], { env: psEnv(home) })
    assert.equal(r.code, 3, `${r.stdout}\n${r.stderr}`)
    assert.deepEqual(clientOutput(r.stdout).argv, ["setup", "--url", srv.url, "--token", TOKEN])
    assert.ok(existsSync(join(home, "install.ps1")) && existsSync(join(home, "brain.cmd")))
  } finally {
    rmSync(root, { recursive: true, force: true })
    await srv.close()
  }
})

test("install.ps1 (Windows) : copie privée de Node.js (zip officiel) vraiment téléchargée et vérifiée (BRAIN_TEST_NETWORK=1)", { skip: WIN ? (NETWORK ? false : "BRAIN_TEST_NETWORK=1 pour télécharger Node.js") : "Windows seulement" }, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(3) } })
  const home = join(tempDir("brain-install-win-"), "brain")
  try {
    const r = await installPs("powershell.exe", ["--url", srv.url, "--token", TOKEN], psEnv(home, { COMPANY_BRAIN_FORCE_PRIVATE_NODE: "1" }), 300_000)
    assert.equal(r.code, 3, `${r.stdout}\n${r.stderr}`)
    const priv = join(home, "node", "node.exe")
    assert.equal(spawnSync(priv, ["-p", "process.versions.node"], { encoding: "utf8" }).stdout.trim(), NODE_VERSION)
    assert.match(readFileSync(join(home, "brain.cmd"), "latin1"), /^@"%~dp0node\\node\.exe" "%~dp0brain\.mjs" %\*\r$/m)
    const s = await runCmd(join(home, "brain.cmd"), ["status"], { ...process.env, COMPANY_BRAIN_HOME: undefined })
    assert.deepEqual(clientOutput(s.stdout), { argv: ["status"], home })
    assert.deepEqual(leftovers(home), [])
  } finally {
    rmSync(dirname(home), { recursive: true, force: true })
    await srv.close()
  }
})
