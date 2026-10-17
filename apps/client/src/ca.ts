// Certificat du cerveau auto-hébergé (HTTPS sur le réseau local, signé par une autorité privée) : le poste lui fait
// confiance pour tous ses appels (synchro, MCP, hooks) sans toucher aux certificats publics, et l'installe dans le
// navigateur quand c'est possible. Le fichier est épinglé par son empreinte SHA-256 dans le prompt d'installation.

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
  /** Un certificat PEM par entrée (le fichier peut contenir une chaîne). */
  certs: string[]
  /** Empreinte SHA-256 du premier certificat, hexadécimal majuscule sans « : » (comme `openssl x509 -fingerprint -sha256`). */
  fingerprint: string
  subject: string
  /** Nom commun (CN) du premier certificat, pour le retrouver dans le trousseau. */
  cn: string
}

export function splitPem(text: string): string[] {
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map((m) => m[0])
}

export function fingerprintOf(pem: string): string {
  return new X509Certificate(pem).fingerprint256.replace(/:/g, "").toUpperCase()
}

/** Lit et vérifie un fichier de certificat (PEM). Erreur « attendue » si le fichier manque ou n'en est pas un. */
export function readCaFile(file: string): CaInfo {
  const path = resolve(file.replace(/^~(?=$|\/)/, homedir()))
  if (!existsSync(path)) throw new UserError(`Certificat introuvable : ${path}.`)
  const pem = readFileSync(path, "utf8")
  const certs = splitPem(pem)
  if (!certs.length) throw new UserError(`${path} ne contient aucun certificat PEM (« -----BEGIN CERTIFICATE----- »).`)
  let x: X509Certificate
  try {
    x = new X509Certificate(certs[0])
  } catch {
    throw new UserError(`${path} : certificat illisible.`)
  }
  const cn = /CN=([^\n]+)/.exec(x.subject)?.[1]?.trim() ?? x.subject
  return { file: path, pem, certs, fingerprint: x.fingerprint256.replace(/:/g, "").toUpperCase(), subject: x.subject, cn }
}

/** « CN, empreinte SHA-256 … » pour status, ou la raison pour laquelle le fichier ne va pas. */
export function describeCa(file: string): string {
  try {
    const i = readCaFile(file)
    return `${i.cn}, empreinte SHA-256 ${i.fingerprint}`
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
 * Fait confiance au certificat pour ce processus, en plus des certificats publics (Node ≥ 22.19). Sur un Node plus
 * ancien, renvoie « reexec » : l'appelant relance le processus avec NODE_EXTRA_CA_CERTS.
 */
export function applyCa(certs: string[], deps: TlsDeps = tls as TlsDeps): "applied" | "reexec" {
  if (typeof deps.setDefaultCACertificates !== "function" || typeof deps.getCACertificates !== "function") return "reexec"
  const current = deps.getCACertificates("default")
  const missing = certs.filter((c) => !current.includes(c))
  if (missing.length) deps.setDefaultCACertificates([...current, ...missing])
  return "applied"
}

/**
 * Au démarrage du client : si la config désigne un certificat, le processus lui fait confiance. Renvoie le code de
 * sortie d'un processus relancé (Node ancien), ou null pour continuer normalement.
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

/** Commande qui installe le certificat dans le magasin de l'utilisateur (navigateurs), sans droits administrateur. */
export function trustCommand(file: string, platform: NodeJS.Platform = process.platform, home = homedir()): TrustCommand | null {
  if (platform === "darwin") {
    return { cmd: "security", args: ["add-trusted-cert", "-r", "trustRoot", "-k", `${home}/Library/Keychains/login.keychain-db`, file], scope: "trousseau de session macOS (Safari, Chrome)" }
  }
  if (platform === "win32") return { cmd: "certutil", args: ["-user", "-addstore", "Root", file], scope: "magasin de certificats de l'utilisateur Windows (Edge, Chrome)" }
  if (platform === "linux") return { cmd: "certutil", args: ["-d", `sql:${home}/.pki/nssdb`, "-A", "-t", "C,,", "-n", "NOS Brainer", "-i", file], scope: "base NSS de l'utilisateur (Chrome, Chromium)" }
  return null
}

export function formatCommand(c: TrustCommand): string {
  return [c.cmd, ...c.args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")
}

/** Installe le certificat pour les navigateurs du poste (au mieux) ; renvoie ce qu'il faut dire à l'utilisateur. */
export function trustInBrowsers(file: string, platform: NodeJS.Platform = process.platform): { ok: boolean; message: string } {
  const c = trustCommand(file, platform)
  if (!c) return { ok: false, message: `Système non géré (${platform}) : importe ${file} dans ton navigateur à la main.` }
  const r = spawnSync(c.cmd, c.args, { encoding: "utf8", timeout: 60_000, windowsHide: true })
  if (!r.error && r.status === 0) return { ok: true, message: `Certificat du cerveau ajouté au ${c.scope}.` }
  const why = r.error ? r.error.message : (r.stderr || r.stdout || "").trim().split("\n")[0] || `code ${r.status}`
  return { ok: false, message: `Certificat du cerveau non installé dans le ${c.scope} (${why}). À lancer à la main : ${formatCommand(c)}` }
}
