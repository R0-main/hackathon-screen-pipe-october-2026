// Certificate of a self-hosted brain (HTTPS on the local network, signed by a private authority): the computer trusts
// it for all its calls (sync, MCP, hooks) without touching the public certificates, and installs it in the
// browser when possible. The file is pinned by its SHA-256 fingerprint in the install prompt.

import { spawnSync } from "node:child_process"
import { X509Certificate } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import tls from "node:tls"
import { UserError } from "./config"

export type CaInfo = {
  file: string
  pem: string
  /** One PEM certificate per entry (the file can contain a chain). */
  certs: string[]
  /** SHA-256 fingerprint of the first certificate, uppercase hex without ":" (like `openssl x509 -fingerprint -sha256`). */
  fingerprint: string
  subject: string
  /** Common name (CN) of the first certificate, to find it in the keychain. */
  cn: string
}

export function splitPem(text: string): string[] {
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map((m) => m[0])
}

export function fingerprintOf(pem: string): string {
  return new X509Certificate(pem).fingerprint256.replace(/:/g, "").toUpperCase()
}

/** Reads and checks a certificate file (PEM). "Expected" error if the file is missing or is not one. */
export function readCaFile(file: string): CaInfo {
  const path = resolve(file.replace(/^~(?=$|\/)/, homedir()))
  if (!existsSync(path)) throw new UserError(`Certificate not found: ${path}.`)
  const pem = readFileSync(path, "utf8")
  const certs = splitPem(pem)
  if (!certs.length) throw new UserError(`${path} contains no PEM certificate ("-----BEGIN CERTIFICATE-----").`)
  let x: X509Certificate
  try {
    x = new X509Certificate(certs[0])
  } catch {
    throw new UserError(`${path}: unreadable certificate.`)
  }
  const cn = /CN=([^\n]+)/.exec(x.subject)?.[1]?.trim() ?? x.subject
  return { file: path, pem, certs, fingerprint: x.fingerprint256.replace(/:/g, "").toUpperCase(), subject: x.subject, cn }
}

/** "CN, SHA-256 fingerprint …" for status, or the reason why the file is not right. */
export function describeCa(file: string): string {
  try {
    const i = readCaFile(file)
    return `${i.cn}, SHA-256 fingerprint ${i.fingerprint}`
  } catch (err) {
    return (err as Error).message
  }
}

export function fingerprintOfFile(file: string): string | null {
  try {
    return readCaFile(file).fingerprint
  } catch {
    return null
  }
}

export type TlsDeps = {
  getCACertificates?: (type: "default" | "system" | "bundled" | "extra") => string[]
  setDefaultCACertificates?: (certs: string[]) => void
}

/**
 * Trusts the certificate for this process, on top of the public certificates (Node ≥ 22.19). On an older
 * Node, returns "reexec": the caller restarts the process with NODE_EXTRA_CA_CERTS.
 */
export function applyCa(certs: string[], deps: TlsDeps = tls as TlsDeps): "applied" | "reexec" {
  if (typeof deps.setDefaultCACertificates !== "function" || typeof deps.getCACertificates !== "function") return "reexec"
  const current = deps.getCACertificates("default")
  const missing = certs.filter((c) => !current.includes(c))
  if (missing.length) deps.setDefaultCACertificates([...current, ...missing])
  return "applied"
}

/**
 * On client start: if the config names a certificate, the process trusts it. Returns the exit code
 * of a restarted process (old Node), or null to carry on normally.
 */
export function trustConfiguredCa(caFile: string | undefined, deps: TlsDeps = tls as TlsDeps, env: NodeJS.ProcessEnv = process.env): number | null {
  if (!caFile || !existsSync(caFile)) return null
  const certs = splitPem(readFileSync(caFile, "utf8"))
  if (!certs.length) return null
  if (applyCa(certs, deps) === "applied") return null
  if (env.NODE_EXTRA_CA_CERTS === caFile) return null
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...env, NODE_EXTRA_CA_CERTS: caFile } })
  return r.status ?? 1
}

export type TrustCommand = { cmd: string; args: string[]; scope: string }

/** Command that installs the certificate in the user's store (browsers), without admin rights. */
export function trustCommand(file: string, platform: NodeJS.Platform = process.platform, home = homedir()): TrustCommand | null {
  if (platform === "darwin") {
    return { cmd: "security", args: ["add-trusted-cert", "-r", "trustRoot", "-k", `${home}/Library/Keychains/login.keychain-db`, file], scope: "macOS login keychain (Safari, Chrome)" }
  }
  if (platform === "win32") return { cmd: "certutil", args: ["-user", "-addstore", "Root", file], scope: "Windows user's certificate store (Edge, Chrome)" }
  if (platform === "linux") return { cmd: "certutil", args: ["-d", `sql:${home}/.pki/nssdb`, "-A", "-t", "C,,", "-n", "NOS Brainer", "-i", file], scope: "user's NSS database (Chrome, Chromium)" }
  return null
}

export function formatCommand(c: TrustCommand): string {
  return [c.cmd, ...c.args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")
}

/** Installs the certificate for the computer's browsers (best effort); returns what to tell the user. */
export function trustInBrowsers(file: string, platform: NodeJS.Platform = process.platform): { ok: boolean; message: string } {
  const c = trustCommand(file, platform)
  if (!c) return { ok: false, message: `Unsupported system (${platform}): import ${file} into your browser by hand.` }
  const r = spawnSync(c.cmd, c.args, { encoding: "utf8", timeout: 60_000, windowsHide: true })
  if (!r.error && r.status === 0) return { ok: true, message: `Brain certificate added to the ${c.scope}.` }
  const why = r.error ? r.error.message : (r.stderr || r.stdout || "").trim().split("\n")[0] || `code ${r.status}`
  return { ok: false, message: `Brain certificate not installed in the ${c.scope} (${why}). To run by hand: ${formatCommand(c)}` }
}
