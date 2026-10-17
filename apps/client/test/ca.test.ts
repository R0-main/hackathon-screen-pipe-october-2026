import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:https"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { applyCa, describeCa, fingerprintOfFile, formatCommand, readCaFile, splitPem, trustCommand, trustConfiguredCa } from "../src/ca"
import { cmdInit, cmdStatus } from "../src/commands"
import { loadConfig } from "../src/config"
import { TEST_ZONES, mockServer, tempDir } from "./helpers"

const clientDir = fileURLToPath(new URL("..", import.meta.url))

// Test authority (self-signed, no private key in the repo), fingerprint taken with `openssl x509 -fingerprint -sha256`.
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIBkjCCATegAwIBAgIUcUCIic+efsEUZfvdVLqqKiHmkOUwCgYIKoZIzj0EAwIw
HjEcMBoGA1UEAwwTTk9TIEJyYWluZXIgdGVzdCBDQTAeFw0yNjEwMTcxNzAwMjZa
Fw0zNjEwMTQxNzAwMjZaMB4xHDAaBgNVBAMME05PUyBCcmFpbmVyIHRlc3QgQ0Ew
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATFaDrkaCV/s705UT2xkNqC43351UkB
pBkt3leRzWgnVZ0z9WmVyLxngZ6KBgaKZiQYUhKKoZ+AH+2Msm70K1lto1MwUTAd
BgNVHQ4EFgQUmoHNEniq+HNFrWm3PbnSQXNnZcgwHwYDVR0jBBgwFoAUmoHNEniq
+HNFrWm3PbnSQXNnZcgwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBG
AiEAnoXuG1Gs2SZwlP6+GKK4gEk9px42aFbhC+Q/a9dtl9QCIQDxgIMcKxumGgLi
yaYsTYEgOmlr2GaS1hMRURRKaVBh0g==
-----END CERTIFICATE-----
`
const TEST_FP = "33483DC29874755818A10E941E52452421D5FF791FCF37578DB0E4EC570DF8F5"
const TOKEN = "cb_test_token_123456"

function caFile(dir = tempDir()): string {
  const file = join(dir, "ca.pem")
  writeFileSync(file, TEST_CA)
  return file
}

function brainHandler(req: { url: string }) {
  const path = req.url.split("?")[0]
  if (path === "/api/whoami") return { body: { org: { name: "Fournil", description: "" }, profile: { id: "u", name: "Jean-Marc Dubois" }, access: { isAdmin: true, readable: ["finance"], writable: ["finance"] }, context: null } }
  if (path === "/api/zones") return { body: { zones: TEST_ZONES } }
  return undefined
}

test("certificate: reading, SHA-256 fingerprint in openssl format, CN, splitting a chain", () => {
  const file = caFile()
  const info = readCaFile(file)
  assert.equal(info.file, file)
  assert.equal(info.fingerprint, TEST_FP)
  assert.equal(info.cn, "NOS Brainer test CA")
  assert.equal(info.certs.length, 1)
  assert.equal(fingerprintOfFile(file), TEST_FP)
  assert.match(describeCa(file), /NOS Brainer test CA, SHA-256 fingerprint 33483DC2/)
  assert.equal(splitPem(`${TEST_CA}\n# comment\n${TEST_CA}`).length, 2)
  assert.throws(() => readCaFile(join(tempDir(), "absent.pem")), /not found/)
  const bad = join(tempDir(), "not-a-cert.pem")
  writeFileSync(bad, "hello")
  assert.throws(() => readCaFile(bad), /contains no PEM certificate/)
  assert.match(describeCa(bad), /contains no PEM certificate/)
})

test("certificate: added to the default certificates of the process, without duplicates; old Node → restart requested", () => {
  let set: string[] | null = null
  const deps = { getCACertificates: () => (set ?? ["PUBLIC"]), setDefaultCACertificates: (c: string[]) => void (set = c) }
  const cert = TEST_CA.trim()
  assert.equal(applyCa([cert], deps), "applied")
  assert.deepEqual(set, ["PUBLIC", cert])
  set = ["PUBLIC", cert]
  const before = set
  assert.equal(applyCa([cert], deps), "applied")
  assert.equal(set, before, "already there: nothing to redo")
  assert.equal(applyCa([TEST_CA], {}), "reexec")
  // On start: nothing to do without a certificate, nor when the restart already happened (NODE_EXTRA_CA_CERTS set).
  assert.equal(trustConfiguredCa(undefined, deps), null)
  assert.equal(trustConfiguredCa(join(tempDir(), "absent.pem"), deps), null)
  const file = caFile()
  set = null
  assert.equal(trustConfiguredCa(file, deps), null)
  assert.deepEqual(set, ["PUBLIC", cert], "the certificate of the file, read as is")
  assert.equal(trustConfiguredCa(file, {}, { NODE_EXTRA_CA_CERTS: file }), null)
})

test("certificate: install command for the browsers depending on the system", () => {
  const mac = trustCommand("/h/ca.pem", "darwin", "/Users/jm")!
  assert.equal(mac.cmd, "security")
  assert.deepEqual(mac.args, ["add-trusted-cert", "-r", "trustRoot", "-k", "/Users/jm/Library/Keychains/login.keychain-db", "/h/ca.pem"])
  assert.equal(trustCommand("C:\\ca.pem", "win32")!.cmd, "certutil")
  assert.match(formatCommand(trustCommand("/h/ca.pem", "linux", "/home/jm")!), /certutil -d sql:\/home\/jm\/\.pki\/nssdb -A -t C,, -n "NOS Brainer" -i \/h\/ca\.pem/)
  assert.equal(trustCommand("/h/ca.pem", "freebsd"), null)
  assert.equal(formatCommand({ cmd: "x", args: ["one two", 'a"b'], scope: "" }), 'x "one two" "a\\"b"')
})

test("init --ca: saved as an absolute path, shown by status, removable with \"none\"", async () => {
  process.env.COMPANY_BRAIN_HOME = tempDir()
  const brain = await mockServer(brainHandler)
  const file = caFile()
  const out: string[] = []
  try {
    assert.equal(await cmdInit({ url: brain.url, token: TOKEN, ca: file }, (s) => out.push(s)), 0)
    assert.equal(loadConfig()?.ca_file, file)
    assert.match(out.join("\n"), /Brain certificate saved: .*NOS Brainer test CA, SHA-256 fingerprint 33483DC2/)
    assert.match(out.join("\n"), /Connection to the brain OK/)
    const status: string[] = []
    await cmdStatus((s) => status.push(s))
    assert.match(status.join("\n"), /Certificate {3}: .*ca\.pem \(NOS Brainer test CA, SHA-256 fingerprint 33483DC2/)
    await assert.rejects(cmdInit({ ca: true }, () => {}), /give the PEM file/)
    await assert.rejects(cmdInit({ ca: join(tempDir(), "absent.pem") }, () => {}), /not found/)
    assert.equal(loadConfig()?.ca_file, file, "an error does not touch the config")
    assert.equal(await cmdInit({ ca: "none" }, (s) => out.push(s)), 0)
    assert.equal(loadConfig()?.ca_file, undefined)
    assert.match(out.join("\n"), /Brain certificate removed/)
  } finally {
    await brain.close()
  }
})

test("brain on private HTTPS: the client trusts it on start thanks to ca_file, and not without", async (t) => {
  const dir = tempDir()
  const cert = join(dir, "cert.pem")
  const key = join(dir, "key.pem")
  const gen = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { encoding: "utf8" })
  if (gen.error || gen.status !== 0) return t.skip(`openssl unavailable (${gen.error?.message ?? gen.stderr.trim().split("\n")[0]})`)
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    const r = brainHandler({ url: req.url ?? "/" })
    if (!r) return void res.writeHead(404).end()
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(r.body))
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  const run = (home: string, args: string[] = ["status"]) =>
    new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: clientDir, env: { ...process.env, COMPANY_BRAIN_HOME: home } })
      let out = ""
      child.stdout.on("data", (d) => (out += d))
      child.stderr.on("data", (d) => (out += d))
      child.on("close", () => resolve(out))
    })
  try {
    const trusted = tempDir()
    mkdirSync(trusted, { recursive: true })
    writeFileSync(join(trusted, "config.json"), JSON.stringify({ url, token: TOKEN, ca_file: cert }))
    const ok = await run(trusted)
    assert.match(ok, /Connection {4}: OK — Jean-Marc Dubois, Fournil/, ok)
    assert.match(ok, /Certificate {3}: .*cert\.pem \(localhost, SHA-256 fingerprint [0-9A-F]{64}\)/)
    const naive = tempDir()
    writeFileSync(join(naive, "config.json"), JSON.stringify({ url, token: TOKEN }))
    const ko = await run(naive)
    assert.match(ko, /Connection {4}: KO/, ko)
    // First install: the certificate given on the command line already counts for init's connection test.
    const fresh = tempDir()
    const init = await run(fresh, ["init", "--url", url, "--token", TOKEN, "--ca", cert])
    assert.match(init, /Brain certificate saved/, init)
    assert.match(init, /Connection to the brain OK: Jean-Marc Dubois/, init)
    assert.equal(JSON.parse(readFileSync(join(fresh, "config.json"), "utf8")).ca_file, cert)
  } finally {
    server.close()
  }
})

test("fingerprint in PowerShell (Windows command of the prompt): the same as openssl and the client", (t) => {
  const file = caFile()
  const expr = `$c = New-Object Security.Cryptography.X509Certificates.X509Certificate2 '${file}'; [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData)) -replace '-'`
  const r = spawnSync("pwsh", ["-NoProfile", "-Command", expr], { encoding: "utf8", timeout: 60_000 })
  if (r.error) return t.skip("pwsh unavailable")
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), TEST_FP)
})
