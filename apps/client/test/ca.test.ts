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

// Autorité de test (auto-signée, sans clé privée dans le dépôt), empreinte relevée avec `openssl x509 -fingerprint -sha256`.
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIBljCCAT2gAwIBAgIUVpDot4mZTuKOOJPRc0zUxtIZ6YgwCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWTk9TIEJyYWluZXIgQ0EgZGUgdGVzdDAeFw0yNjEwMTcxMjMz
NTVaFw0zNjEwMTQxMjMzNTVaMCExHzAdBgNVBAMMFk5PUyBCcmFpbmVyIENBIGRl
IHRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATVS8M+lUd7oJVmi6618Ahl
FWHtcY8+rbhlnowYoZ3HDgOMSEuvn8qpW63wRiPDzF8snOk5mOXlqcMM2kueP5vc
o1MwUTAdBgNVHQ4EFgQUaWlnpulx3JhWD5rDO7dTyzjvGbYwHwYDVR0jBBgwFoAU
aWlnpulx3JhWD5rDO7dTyzjvGbYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD
AgNHADBEAiBPsdtD86YVy65pbEifs3kbpBBuQsOvjS+hTa0MEHGw9AIgDALLMJDr
ALsopZ2SPQMbes0V+YCiIWBIkSGxskd3uGo=
-----END CERTIFICATE-----
`
const TEST_FP = "57A3ACBF1A89EFD08B67BFA91AB261072FB73EC1C5A0102D2B6BF584C7201C49"
const TOKEN = "cb_test_token_123456"

function caFile(dir = tempDir()): string {
  const file = join(dir, "ca.pem")
  writeFileSync(file, TEST_CA)
  return file
}

function brainHandler(req: { url: string }) {
  const path = req.url.split("?")[0]
  if (path === "/api/whoami") return { body: { org: { name: "Fournil", description: "" }, profile: { id: "u", name: "Jean-Marc Dubois" }, access: { isAdmin: true, readable: ["compta"], writable: ["compta"] }, context: null } }
  if (path === "/api/zones") return { body: { zones: TEST_ZONES } }
  return undefined
}

test("certificat : lecture, empreinte SHA-256 au format openssl, CN, découpage d'une chaîne", () => {
  const file = caFile()
  const info = readCaFile(file)
  assert.equal(info.file, file)
  assert.equal(info.fingerprint, TEST_FP)
  assert.equal(info.cn, "NOS Brainer CA de test")
  assert.equal(info.certs.length, 1)
  assert.equal(fingerprintOfFile(file), TEST_FP)
  assert.match(describeCa(file), /NOS Brainer CA de test, empreinte SHA-256 57A3ACBF/)
  assert.equal(splitPem(`${TEST_CA}\n# commentaire\n${TEST_CA}`).length, 2)
  assert.throws(() => readCaFile(join(tempDir(), "absent.pem")), /introuvable/)
  const bad = join(tempDir(), "pas-un-cert.pem")
  writeFileSync(bad, "bonjour")
  assert.throws(() => readCaFile(bad), /aucun certificat PEM/)
  assert.match(describeCa(bad), /aucun certificat PEM/)
})

test("certificat : ajouté aux certificats par défaut du processus, sans doublon ; Node ancien → relance demandée", () => {
  let set: string[] | null = null
  const deps = { getCACertificates: () => (set ?? ["PUBLIC"]), setDefaultCACertificates: (c: string[]) => void (set = c) }
  const cert = TEST_CA.trim()
  assert.equal(applyCa([cert], deps), "applied")
  assert.deepEqual(set, ["PUBLIC", cert])
  set = ["PUBLIC", cert]
  const before = set
  assert.equal(applyCa([cert], deps), "applied")
  assert.equal(set, before, "déjà présent : rien à refaire")
  assert.equal(applyCa([TEST_CA], {}), "reexec")
  // Au démarrage : rien à faire sans certificat, ni quand la relance a déjà eu lieu (NODE_EXTRA_CA_CERTS posé).
  assert.equal(trustConfiguredCa(undefined, deps), null)
  assert.equal(trustConfiguredCa(join(tempDir(), "absent.pem"), deps), null)
  const file = caFile()
  set = null
  assert.equal(trustConfiguredCa(file, deps), null)
  assert.deepEqual(set, ["PUBLIC", cert], "le certificat du fichier, lu tel quel")
  assert.equal(trustConfiguredCa(file, {}, { NODE_EXTRA_CA_CERTS: file }), null)
})

test("certificat : commande d'installation pour les navigateurs selon le système", () => {
  const mac = trustCommand("/h/ca.pem", "darwin", "/Users/jm")!
  assert.equal(mac.cmd, "security")
  assert.deepEqual(mac.args, ["add-trusted-cert", "-r", "trustRoot", "-k", "/Users/jm/Library/Keychains/login.keychain-db", "/h/ca.pem"])
  assert.equal(trustCommand("C:\\ca.pem", "win32")!.cmd, "certutil")
  assert.match(formatCommand(trustCommand("/h/ca.pem", "linux", "/home/jm")!), /certutil -d sql:\/home\/jm\/\.pki\/nssdb -A -t C,, -n "NOS Brainer" -i \/h\/ca\.pem/)
  assert.equal(trustCommand("/h/ca.pem", "freebsd"), null)
  assert.equal(formatCommand({ cmd: "x", args: ["un deux", 'a"b'], scope: "" }), 'x "un deux" "a\\"b"')
})

test("init --ca : enregistré en chemin absolu, affiché par status, retirable avec « aucun »", async () => {
  process.env.COMPANY_BRAIN_HOME = tempDir()
  const brain = await mockServer(brainHandler)
  const file = caFile()
  const out: string[] = []
  try {
    assert.equal(await cmdInit({ url: brain.url, token: TOKEN, ca: file }, (s) => out.push(s)), 0)
    assert.equal(loadConfig()?.ca_file, file)
    assert.match(out.join("\n"), /Certificat du cerveau enregistré : .*NOS Brainer CA de test, empreinte SHA-256 57A3ACBF/)
    assert.match(out.join("\n"), /Connexion au cerveau OK/)
    const status: string[] = []
    await cmdStatus((s) => status.push(s))
    assert.match(status.join("\n"), /Certificat {4}: .*ca\.pem \(NOS Brainer CA de test, empreinte SHA-256 57A3ACBF/)
    await assert.rejects(cmdInit({ ca: true }, () => {}), /donnez le fichier PEM/)
    await assert.rejects(cmdInit({ ca: join(tempDir(), "absent.pem") }, () => {}), /introuvable/)
    assert.equal(loadConfig()?.ca_file, file, "une erreur ne touche pas la config")
    assert.equal(await cmdInit({ ca: "aucun" }, (s) => out.push(s)), 0)
    assert.equal(loadConfig()?.ca_file, undefined)
    assert.match(out.join("\n"), /Certificat du cerveau retiré/)
  } finally {
    await brain.close()
  }
})

test("cerveau en HTTPS privé : le client lui fait confiance au démarrage grâce à ca_file, et pas sans", async (t) => {
  const dir = tempDir()
  const cert = join(dir, "cert.pem")
  const key = join(dir, "key.pem")
  const gen = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { encoding: "utf8" })
  if (gen.error || gen.status !== 0) return t.skip(`openssl indisponible (${gen.error?.message ?? gen.stderr.trim().split("\n")[0]})`)
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
    assert.match(ok, /Connexion {5}: OK — Jean-Marc Dubois, Fournil/, ok)
    assert.match(ok, /Certificat {4}: .*cert\.pem \(localhost, empreinte SHA-256 [0-9A-F]{64}\)/)
    const naive = tempDir()
    writeFileSync(join(naive, "config.json"), JSON.stringify({ url, token: TOKEN }))
    const ko = await run(naive)
    assert.match(ko, /Connexion {5}: KO/, ko)
    // Première installation : le certificat donné sur la ligne de commande compte dès le test de connexion d'init.
    const fresh = tempDir()
    const init = await run(fresh, ["init", "--url", url, "--token", TOKEN, "--ca", cert])
    assert.match(init, /Certificat du cerveau enregistré/, init)
    assert.match(init, /Connexion au cerveau OK : Jean-Marc Dubois/, init)
    assert.equal(JSON.parse(readFileSync(join(fresh, "config.json"), "utf8")).ca_file, cert)
  } finally {
    server.close()
  }
})
