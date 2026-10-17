// install.sh and install.ps1, the bootstrap scripts served by the dashboard (apps/web/public): tested against a fake brain
// server, in temporary folders (HOME and COMPANY_BRAIN_HOME), never in the user's real folder.
// No network, except with BRAIN_TEST_NETWORK=1: the private copy of Node.js is then really downloaded (~30 MB).

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
const POSIX_ONLY = { skip: WIN ? "POSIX only" : false }
const WIN_ONLY = { skip: WIN ? false : "Windows only" }
const TOKEN = "cb_TEST_tok3n_never_printed"

// --- Tools ---------------------------------------------------------------------------------------------------------

type Run = { code: number | null; stdout: string; stderr: string }

/** Runs a command, with a timer that kills it (60 s by default): a stuck script does not block the rest. */
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

/** Fake brain server: serves the given files, 404 for the rest, and records the paths requested. */
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

/** Fake client: prints its arguments and the folder it sees, then exits with the given code (3 = permission pending). */
const fakeClient = (code: number) =>
  `#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), home: process.env.COMPANY_BRAIN_HOME ?? null }))\nprocess.exit(${code})\n`
const HTML = "<!DOCTYPE html>\n<html><body>Hotel Wi-Fi sign-in</body></html>\n"

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The JSON line written by the fake client. */
function clientOutput(stdout: string): { argv: string[]; home: string | null } {
  const line = stdout.split("\n").find((l) => l.startsWith('{"argv"'))
  assert.ok(line, `the fake client did not run:\n${stdout}`)
  return JSON.parse(line)
}

// --- POSIX test computers ---------------------------------------------------------------------------------------

// Same rule as install.sh: a Node.js from a version manager (or x64 on Apple Silicon) is not kept. On such a
// development computer, the tests provide a fake private copy rather than downloading Node.js.
const VERSIONED = /\/(Cellar|\.nvm|fnm|\.fnm|\.volta|\.asdf|mise|\.nodenv|n\/versions|\.local\/share\/pnpm|pnpm\/nodejs)\/|^\/snap\//
const realNode = realpathSync(process.execPath)
const appleSilicon = process.platform === "darwin" && spawnSync("sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).stdout?.trim() === "1"
const systemNodeUsable = !WIN && !VERSIONED.test(realNode) && (!appleSilicon || process.arch === "arm64")
const realCurl = WIN ? "" : spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim()

/** POSIX shells available: install.sh must work with each one. */
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
 * A test computer: HOME and COMPANY_BRAIN_HOME in a temporary folder, and in front of the PATH a spy curl that records
 * every URL. nodejs.org is blocked there, except with ALLOW_NODEJS_ORG=1: never a surprise download of Node.js.
 */
function workstation(opts: { home?: (root: string) => string } = {}) {
  const root = tempDir("brain-install-")
  const home = opts.home ? opts.home(root) : join(root, "brain")
  const bin = join(root, "bin")
  writeExec(
    join(bin, "curl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/curl.log'
case "$*" in *nodejs.org*) [ "\${ALLOW_NODEJS_ORG:-}" = 1 ] || { echo "curl: nodejs.org blocked by the test" >&2; exit 7; } ;; esac
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

/** Fake private Node.js: answers install.sh's probe (-p) with the wanted version, passes everything else to the real Node.js. */
function fakePrivateNode(home: string, version: string): string {
  const file = join(home, "node", "bin", "node")
  writeExec(file, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo "${version} ${process.arch} $0"; exit 0; fi\nexec '${process.execPath}' "$@"\n`)
  return file
}

/** Fake system Node.js, stored in `dir`: probe with the wanted version; old (< 20), it refuses everything else. */
function fakeSystemNode(dir: string, version: string, arch: string = process.arch): string {
  const file = join(dir, "node")
  const rest = Number(version.split(".")[0]) >= 20 ? `exec '${process.execPath}' "$@"` : `echo "node v${version}: too old for this test" >&2; exit 1`
  writeExec(file, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo "${version} ${arch} $0"; exit 0; fi\n${rest}\n`)
  return file
}

/** Fake uname: the wanted system and processor (install.sh only reads -s and -m). */
function fakeUname(bin: string, system: string, machine: string) {
  writeExec(join(bin, "uname"), `#!/bin/sh\ncase "$1" in -m) echo ${machine} ;; *) echo ${system} ;; esac\n`)
}

/** Node.js without a download: the system one if install.sh keeps it, otherwise a fake pinned private copy. */
function withNode(ws: Workstation) {
  if (!systemNodeUsable) fakePrivateNode(ws.home, NODE_VERSION)
}

function installShell(shell: string[], args: string[], ws: Workstation, extra: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}) {
  return run(shell[0], [...shell.slice(1), installSh, ...args], { env: { ...ws.env, ...extra.env }, cwd: extra.cwd ?? ws.root, timeoutMs: extra.timeoutMs })
}
const install = (args: string[], ws: Workstation, extra: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}) => installShell(["sh"], args, ws, extra)

/** Runs the ~/.company-brain/brain shortcut without COMPANY_BRAIN_HOME: it must set it itself. */
function shortcut(ws: Workstation, args: string[], cwd = tmpdir()) {
  const env = { ...ws.env }
  delete env.COMPANY_BRAIN_HOME
  return run(join(ws.home, "brain"), args, { env, cwd })
}

function leftovers(home: string): string[] {
  return existsSync(home) ? readdirSync(home).filter((f) => /\.(new|tmp|download|old)\b|\.\d+$/.test(f)) : []
}

// --- install.sh ----------------------------------------------------------------------------------------------------

test("install.sh: valid POSIX syntax (sh, dash, bash --posix)", POSIX_ONLY, () => {
  for (const shell of shells()) {
    const r = spawnSync(shell[0], [...shell.slice(1), "-n", installSh], { encoding: "utf8" })
    assert.equal(r.status, 0, `${shell.join(" ")} -n: ${r.stderr}`)
  }
})

test("install.sh: bad call → code 2, nothing installed, the token never shown", POSIX_ONLY, async () => {
  const ws = workstation()
  try {
    const cases: [string[], RegExp][] = [
      [["--token", TOKEN], /Usage/],
      [["--url", "ftp://brain.example.com", "--token", TOKEN], /https:\/\//],
      [["--url", "brain.example.com", "--token", TOKEN], /https:\/\//],
      [["--url", TOKEN], /https:\/\//],
    ]
    for (const [args, message] of cases) {
      const r = await install(args, ws)
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`)
      assert.match(r.stderr, message)
      assert.ok(!(r.stdout + r.stderr).includes(TOKEN), "token shown")
    }
    // sudo: a fake `id` that answers 0 (root) and SUDO_USER, as under sudo. The script stops before writing anything.
    writeExec(join(ws.bin, "id"), `#!/bin/sh\nif [ "$1" = "-u" ]; then echo 0; else exec /usr/bin/id "$@"; fi\n`)
    const sudo = await install(["--url", "https://brain.example.com", "--token", TOKEN], ws, { env: { SUDO_USER: "jean" } })
    assert.equal(sudo.code, 2, sudo.stderr)
    assert.match(sudo.stderr, /without sudo/)
    assert.ok(!existsSync(ws.home), "nothing is created")
    assert.equal(ws.curlLog(), "", "nothing is downloaded")
  } finally {
    ws.cleanup()
  }
})

for (const shell of shells()) {
  test(`install.sh (${shell.join(" ")}): downloads brain.mjs, writes the shortcut, runs setup with the same options and returns its code`, POSIX_ONLY, async () => {
    const srv = await brainServer({ "/brain.mjs": { body: fakeClient(3) } })
    const ws = workstation()
    withNode(ws)
    try {
      const r = await installShell(shell, ["--url", `${srv.url}/`, "--token", TOKEN, "--no-open"], ws)
      assert.equal(r.code, 3, `setup's code is returned as is\n${r.stdout}\n${r.stderr}`)
      assert.deepEqual(clientOutput(r.stdout), { argv: ["setup", "--url", `${srv.url}/`, "--token", TOKEN, "--no-open"], home: ws.home })
      const rest = r.stdout.split("\n").filter((l) => !l.startsWith('{"argv"')).join("\n") + r.stderr
      assert.ok(!rest.includes(TOKEN), "token shown by install.sh")
      assert.equal(readFileSync(join(ws.home, "brain.mjs"), "utf8"), fakeClient(3))
      assert.equal(statSync(ws.home).mode & 0o777, 0o700, "private folder")
      assert.ok(statSync(join(ws.home, "brain")).mode & 0o100, "executable shortcut")
      assert.deepEqual(leftovers(ws.home), [])
      assert.equal(ws.curlLog().trim().split("\n").length, 1, `only brain.mjs is downloaded:\n${ws.curlLog()}`)
      assert.ok(ws.curlLog().includes(`${srv.url}/brain.mjs`))
      // The shortcut works from elsewhere, without COMPANY_BRAIN_HOME in the environment: it sets it itself.
      const s = await shortcut(ws, ["status"])
      assert.equal(s.code, 3)
      assert.deepEqual(clientOutput(s.stdout), { argv: ["status"], home: ws.home })
    } finally {
      ws.cleanup()
      await srv.close()
    }
  })
}

test("install.sh: --url=… works too, and is passed as is to setup", POSIX_ONLY, async () => {
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

test("install.sh --join (team message): runs join, not setup, with the same options; code returned as is", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(7) } })
  const ws = workstation()
  withNode(ws)
  try {
    const args = ["--url", srv.url, "--join", "cj_test", "--name", "Léa Bernard", "--title", "Finance"]
    const r = await install(args, ws)
    assert.equal(r.code, 7, `${r.stdout}\n${r.stderr}`)
    assert.deepEqual(clientOutput(r.stdout).argv, ["join", ...args])
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh: brain.mjs not found (404) → code 5, clear message, nothing installed", POSIX_ONLY, async () => {
  const srv = await brainServer({})
  const ws = workstation()
  withNode(ws)
  try {
    const r = await install(["--url", srv.url, "--token", TOKEN], ws)
    assert.equal(r.code, 5, r.stderr)
    assert.match(r.stderr, /Download failed: http:\/\/127\.0\.0\.1:\d+\/brain\.mjs .*Run the same command again/)
    assert.ok(!existsSync(join(ws.home, "brain.mjs")) && !existsSync(join(ws.home, "brain")))
    assert.deepEqual(leftovers(ws.home), [])
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh: an HTML page served with 200 → code 5, the old client and the shortcut stay intact", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: HTML } })
  const ws = workstation()
  withNode(ws)
  try {
    mkdirSync(ws.home, { recursive: true })
    const oldClient = "// old client, which works\nconsole.log('ok')\n"
    const oldShortcut = "#!/bin/sh\necho old shortcut\n"
    writeFileSync(join(ws.home, "brain.mjs"), oldClient)
    writeExec(join(ws.home, "brain"), oldShortcut)
    const r = await install(["--url", srv.url, "--token", TOKEN], ws)
    assert.equal(r.code, 5, r.stderr)
    assert.match(r.stderr, /is not the brain client .*run the same command again/)
    assert.equal(readFileSync(join(ws.home, "brain.mjs"), "utf8"), oldClient)
    assert.equal(readFileSync(join(ws.home, "brain"), "utf8"), oldShortcut)
    assert.deepEqual(leftovers(ws.home), [])
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh: folder with a space, an apostrophe and $ → the shortcut works and nothing is interpreted", POSIX_ONLY, async () => {
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
    assert.ok(!existsSync(join(ws.root, "PWNED")) && !existsSync(join(ws.root, "PWNED2")), "the path was interpreted")
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh: a relative COMPANY_BRAIN_HOME becomes absolute, for setup as for the shortcut", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(0) } })
  const ws = workstation()
  try {
    const abs = join(ws.root, "relative folder", "brain")
    if (!systemNodeUsable) fakePrivateNode(abs, NODE_VERSION)
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env: { COMPANY_BRAIN_HOME: "relative folder/brain" }, cwd: ws.root })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(clientOutput(r.stdout).home, abs)
    const s = await run(join(abs, "brain"), ["status"], { env: { ...ws.env, COMPANY_BRAIN_HOME: undefined }, cwd: tmpdir() })
    assert.deepEqual(clientOutput(s.stdout), { argv: ["status"], home: abs })
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh: private copy at the pinned version → kept, even with an old node (v18) in the PATH; no download of Node.js", POSIX_ONLY, async () => {
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

test("install.sh: Node.js too old and nodejs.org unreachable → code 5, nothing broken", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(0) } })
  const ws = workstation()
  try {
    fakeSystemNode(join(ws.root, "old"), "18.20.4")
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env: { PATH: [join(ws.root, "old"), ws.env.PATH].join(delimiter) } })
    assert.equal(r.code, 5, r.stderr)
    assert.match(r.stdout, /v18\.20\.4 .* too old/)
    assert.match(r.stderr, new RegExp(`Download failed: ${esc(`https://nodejs.org/dist/v${NODE_VERSION}/node-v`)}.*Run the same command again`))
    assert.ok(!existsSync(join(ws.home, "node")) && !existsSync(join(ws.home, "brain.mjs")))
    assert.deepEqual(leftovers(ws.home), [])
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh: old private copy and download impossible → it is kept, with a warning", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(3) } })
  const ws = workstation()
  try {
    fakePrivateNode(ws.home, "22.1.0")
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env: { COMPANY_BRAIN_FORCE_PRIVATE_NODE: "1" } })
    assert.equal(r.code, 3, r.stderr)
    assert.ok(ws.curlLog().includes("nodejs.org"), "the new version was attempted")
    assert.match(r.stderr, /Continuing with the private copy already installed \(Node\.js v22\.1\.0\)/)
    assert.ok(existsSync(join(ws.home, "node", "bin", "node")))
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh: Node.js from a version manager (nvm) → private copy attempted first; nvm only as a last resort", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(0) } })
  const ws = workstation()
  try {
    const nvmBin = join(ws.root, ".nvm", "versions", "node", "v22.9.0", "bin")
    const nvmNode = fakeSystemNode(nvmBin, "22.9.0")
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env: { PATH: [nvmBin, ws.env.PATH].join(delimiter) } })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /version manager/)
    assert.ok(ws.curlLog().includes("nodejs.org"), "the private copy was attempted before nvm")
    assert.ok(r.stderr.includes(`Continuing with ${nvmNode}`), r.stderr)
    assert.match(readFileSync(join(ws.home, "brain"), "utf8"), new RegExp(`^exec '${esc(nvmNode)}' `, "m"))
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh: system Node.js → the shortcut keeps its real path, not the link's or the shim's", { skip: systemNodeUsable ? false : "this computer's Node.js is ruled out by install.sh (version manager)" }, async () => {
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

test("install.sh: Linux musl (Alpine) → official linux-x64-musl archive; musl on ARM → code 4 with the apk command", POSIX_ONLY, async () => {
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

test("install.sh: Apple Silicon Mac under Rosetta → x64 Node.js ruled out, darwin-arm64 archive", POSIX_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(0) } })
  const ws = workstation()
  try {
    // Under Rosetta, uname -m says x86_64 but hw.optional.arm64 is 1.
    fakeUname(ws.bin, "Darwin", "x86_64")
    writeExec(join(ws.bin, "sysctl"), `#!/bin/sh\n[ "$2" = hw.optional.arm64 ] && echo 1\n`)
    const rosetta = join(ws.root, "usr-local-bin")
    fakeSystemNode(rosetta, "22.9.0", "x64")
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env: { PATH: [rosetta, ws.env.PATH].join(delimiter) } })
    assert.equal(r.code, 5, r.stderr)
    assert.match(r.stdout, /is x64 \(Rosetta\)/)
    assert.ok(ws.curlLog().includes(`node-v${NODE_VERSION}-darwin-arm64.tar.gz`), ws.curlLog())
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh on Windows (Git Bash): downloads install.ps1 and hands over to it, code returned as is", POSIX_ONLY, async () => {
  const ps1 = readFileSync(installPs1, "utf8")
  const srv = await brainServer({ "/install.ps1": { body: ps1 } })
  const ws = workstation()
  try {
    // Fake Git Bash: MINGW uname, cygpath that marks Windows paths "W:", powershell.exe that prints what it receives.
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
    assert.ok(!existsSync(join(ws.home, "brain.mjs")), "the work is done by install.ps1")

    // An HTML page instead of install.ps1: code 5, never run.
    const html = await brainServer({ "/install.ps1": { body: HTML } })
    try {
      const h = await install(["--url", html.url, "--token", TOKEN], ws)
      assert.equal(h.code, 5, h.stderr)
      assert.match(h.stderr, /is not the install script/)
      assert.equal(readFileSync(join(ws.home, "install.ps1"), "utf8"), ps1)
    } finally {
      await html.close()
    }
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

test("install.sh: private copy of Node.js really downloaded and checked (BRAIN_TEST_NETWORK=1)", { skip: WIN ? "POSIX only" : NETWORK ? false : "BRAIN_TEST_NETWORK=1 to download Node.js" }, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(3) } })
  const ws = workstation()
  try {
    // An old private copy in place: the new one replaces it (swap without loss).
    fakePrivateNode(ws.home, "22.1.0")
    const env = { COMPANY_BRAIN_FORCE_PRIVATE_NODE: "1", ALLOW_NODEJS_ORG: "1" }
    const r = await install(["--url", srv.url, "--token", TOKEN], ws, { env, timeoutMs: 300_000 })
    assert.equal(r.code, 3, `${r.stdout}\n${r.stderr}`)
    const priv = join(ws.home, "node", "bin", "node")
    assert.equal(spawnSync(priv, ["-p", "process.versions.node"], { encoding: "utf8" }).stdout.trim(), NODE_VERSION)
    assert.deepEqual(clientOutput(r.stdout).argv, ["setup", "--url", srv.url, "--token", TOKEN])
    assert.match(readFileSync(join(ws.home, "brain"), "utf8"), new RegExp(`^exec '${esc(priv)}' `, "m"))
    assert.deepEqual(leftovers(ws.home), [])
    // Run again: the private copy at the pinned version is kept, without a new download.
    const again = await install(["--url", srv.url, "--token", TOKEN], ws, { env })
    assert.equal(again.code, 3, again.stderr)
    assert.equal(ws.curlLog().split("\n").filter((l) => l.includes("nodejs.org")).length, 1)
  } finally {
    ws.cleanup()
    await srv.close()
  }
})

// --- install.ps1 ---------------------------------------------------------------------------------------------------

test("install.ps1: pure ASCII (Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI) and starts with the mark checked by install.sh", () => {
  const bytes = readFileSync(installPs1)
  const bad = [...bytes].findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09))
  assert.equal(bad, -1, `non-ASCII character at byte ${bad}: ${bytes.subarray(Math.max(0, bad - 40), bad + 10).toString("latin1")}`)
  assert.ok(bytes.toString("ascii").startsWith("# NOS Brainer"))
})

/** PowerShells available on this computer: pwsh (7) everywhere, powershell.exe (5.1) on Windows. */
const powershells = [...(has("pwsh", ["-NoProfile", "-Command", "exit 0"]) ? ["pwsh"] : []), ...(WIN && has("powershell.exe", ["-NoProfile", "-Command", "exit 0"]) ? ["powershell.exe"] : [])]

test("install.ps1: parsed without errors by PowerShell", { skip: powershells.length ? false : "neither pwsh nor powershell.exe" }, () => {
  const path = installPs1.replace(/'/g, "''")
  for (const ps of powershells) {
    const script = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$null, [ref]$e); $e | ForEach-Object { $_.ToString() }; exit $e.Count`
    const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 60_000 })
    assert.equal(r.status, 0, `${ps} : ${r.stdout}${r.stderr}`)
  }
})

/** install.ps1 run as the prompt does: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 <options>. */
function installPs(ps: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs?: number) {
  return run(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installPs1, ...args], { env, timeoutMs })
}

function psEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, COMPANY_BRAIN_HOME: home, ...extra }
  for (const k of ["COMPANY_BRAIN_FORCE_PRIVATE_NODE", "SUDO_USER"]) if (!(k in extra)) delete env[k]
  const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",")
  return { ...env, no_proxy: noProxy, NO_PROXY: noProxy }
}

// Outside Windows, pwsh runs the same logic (arguments, address, download, check, shortcuts) with the system
// Node.js: enough to test install.ps1 on the Linux CI. What is specific to Windows is tested further down.
const pwshHere = !WIN && powershells.includes("pwsh") && systemNodeUsable
test("install.ps1 (pwsh outside Windows): options, --url= joined back, setup's code returned, shortcuts; HTML → 5; without --url → 2", { skip: pwshHere ? false : "pwsh missing, or Windows" }, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(3) } })
  const root = tempDir("brain-install-ps-")
  const home = join(root, "brain home")
  // The Node.js running these tests first in the PATH: it is the one install.ps1 must keep.
  const env = psEnv(home, { PATH: [dirname(process.execPath), process.env.PATH].join(delimiter) })
  try {
    // "--url=http://…": powershell -File splits it in two; install.ps1 must join it back, for itself as for setup.
    const r = await installPs("pwsh", [`--url=${srv.url}/`, "--token", TOKEN, "--wait", "300"], env)
    assert.equal(r.code, 3, `${r.stdout}\n${r.stderr}`)
    assert.deepEqual(clientOutput(r.stdout), { argv: ["setup", `--url=${srv.url}/`, "--token", TOKEN, "--wait", "300"], home })
    assert.ok(!(r.stdout.split("\n").filter((l) => !l.startsWith('{"argv"')).join("\n") + r.stderr).includes(TOKEN), "token shown")
    const cmd = readFileSync(join(home, "brain.cmd"), "latin1")
    assert.equal(cmd, `@setlocal\r\n@set "COMPANY_BRAIN_HOME=${home}"\r\n@"${realNode}" "%~dp0brain.mjs" %*\r\n`)
    const s = await run("sh", [join(home, "brain"), "status"], { env: { ...process.env, COMPANY_BRAIN_HOME: undefined }, cwd: tmpdir() })
    assert.deepEqual(clientOutput(s.stdout), { argv: ["status"], home })
    assert.deepEqual(leftovers(home), [])

    const html = await brainServer({ "/brain.mjs": { body: HTML } })
    try {
      const h = await installPs("pwsh", ["--url", html.url, "--token", TOKEN], env)
      assert.equal(h.code, 5, h.stderr)
      assert.match(h.stderr, /is not the brain client/)
      assert.equal(readFileSync(join(home, "brain.mjs"), "utf8"), fakeClient(3), "the old client stays intact")
    } finally {
      await html.close()
    }
    // --join (team message): join instead of setup, same options, code returned as is.
    const joinSrv = await brainServer({ "/brain.mjs": { body: fakeClient(8) } })
    try {
      const j = await installPs("pwsh", ["--url", joinSrv.url, "--join", "cj_test", "--name", "Léa Bernard"], env)
      assert.equal(j.code, 8, `${j.stdout}\n${j.stderr}`)
      assert.deepEqual(clientOutput(j.stdout).argv, ["join", "--url", joinSrv.url, "--join", "cj_test", "--name", "Léa Bernard"])
    } finally {
      await joinSrv.close()
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
 * The prompt's Windows line, as is, passed to `powershell -Command` as Claude Code's PowerShell tool does:
 * setup's code must come back up (3, 6), and a failed download give 5. Outside Windows (pwsh), "\\" is not a
 * path separator: replaced with "/" for the trial, and `powershell` with `pwsh`.
 */
async function promptLine(ps: string, files: Record<string, { status?: number; body: string }>): Promise<Run> {
  const srv = await brainServer(files)
  const profile = tempDir("brain-prompt-ps-")
  try {
    const windows = installCommands(srv.url, TOKEN).windows
    if (!windows) throw new Error("without a private certificate, the prompt always has a Windows command")
    let line = windows
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
test("Windows line of the prompt: setup's code returned as is, failed download → 5, token never shown", { skip: promptShell ? false : "neither powershell.exe (Windows) nor pwsh" }, async () => {
  const ps1 = { body: readFileSync(installPs1, "utf8") }
  for (const code of [0, 3, 6]) {
    const r = await promptLine(promptShell, { "/install.ps1": ps1, "/brain.mjs": { body: fakeClient(code) } })
    assert.equal(r.code, code, `${r.stdout}\n${r.stderr}`)
    assert.ok(!(r.stdout.split("\n").filter((l) => !l.startsWith('{"argv"')).join("\n") + r.stderr).includes(TOKEN), "token shown")
  }
  const missing = await promptLine(promptShell, { "/brain.mjs": { body: fakeClient(0) } })
  assert.equal(missing.code, 5, `${missing.stdout}\n${missing.stderr}`)
})

// --- Windows -------------------------------------------------------------------------------------------------------

/** Runs brain.cmd through cmd, as from a Windows terminal. */
function runCmd(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return run("cmd.exe", ["/d", "/s", "/c", `""${file}" ${args.join(" ")}"`], { env, windowsVerbatimArguments: true })
}

test("install.ps1 (Windows): --url= joined back, brain.cmd and brain written, setup run with the same options, code returned; brain.cmd works through cmd", WIN_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: fakeClient(3) } })
  const home = join(tempDir("brain-install-win-"), "brain")
  try {
    // --url= form: Windows PowerShell 5.1 also splits "-name:value"; install.ps1 must join the address back.
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

test("install.ps1 (Windows): HTML page instead of the client → code 5, the old client stays intact", WIN_ONLY, async () => {
  const srv = await brainServer({ "/brain.mjs": { body: HTML } })
  const home = join(tempDir("brain-install-win-"), "brain")
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "brain.mjs"), "// old client\n")
    const r = await installPs("powershell.exe", ["--url", srv.url, "--token", TOKEN], psEnv(home))
    assert.equal(r.code, 5, `${r.stdout}\n${r.stderr}`)
    assert.equal(readFileSync(join(home, "brain.mjs"), "utf8"), "// old client\n")
  } finally {
    rmSync(dirname(home), { recursive: true, force: true })
    await srv.close()
  }
})

const gitBash = WIN ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe") : ""
test("install.sh in Git Bash (Windows): hands over to install.ps1 and returns setup's code", { skip: WIN ? (existsSync(gitBash) ? false : "Git Bash missing") : "Windows only" }, async () => {
  const ps1 = readFileSync(installPs1, "utf8")
  const srv = await brainServer({ "/install.ps1": { body: ps1 }, "/brain.mjs": { body: fakeClient(3) } })
  const root = tempDir("brain-install-gitbash-")
  const home = join(root, "brain")
  try {
    // Copy with LF line endings: a repo checked out with core.autocrlf=true would give an install.sh sh cannot read.
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

test("install.ps1 (Windows): private copy of Node.js (official zip) really downloaded and checked (BRAIN_TEST_NETWORK=1)", { skip: WIN ? (NETWORK ? false : "BRAIN_TEST_NETWORK=1 to download Node.js") : "Windows only" }, async () => {
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
