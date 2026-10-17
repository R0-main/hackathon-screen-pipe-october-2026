// Cerveau auto-hébergé en HTTPS local : le certificat de son autorité privée (BRAIN_CA_FILE, en PEM) est servi sur
// /ca.crt et son empreinte SHA-256 est épinglée dans les prompts d'installation, pour que chaque poste vérifie ce
// qu'il récupère avant de lui faire confiance. Sans BRAIN_CA_FILE (cloud, certificat public) : rien ne change.

import { X509Certificate } from "node:crypto"
import { readFileSync, statSync } from "node:fs"

type Loaded = { mtime: number; pem: string; fingerprint: string }
let cache: Loaded | null = null

/** Empreinte SHA-256 du premier certificat, hexadécimal majuscule sans « : » (comme `openssl x509 -fingerprint -sha256`). */
export function fingerprintOf(pem: string): string | null {
  const first = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(pem)?.[0]
  if (!first) return null
  try {
    return new X509Certificate(first).fingerprint256.replace(/:/g, "").toUpperCase()
  } catch {
    return null
  }
}

/** Le certificat configuré, relu quand le fichier change ; null si absent ou pas encore créé (Caddy démarre). */
export function brainCa(): { pem: string; fingerprint: string } | null {
  const file = process.env.BRAIN_CA_FILE
  if (!file) return null
  try {
    const mtime = statSync(file).mtimeMs
    if (!cache || cache.mtime !== mtime) {
      const pem = readFileSync(file, "utf8")
      const fingerprint = fingerprintOf(pem)
      if (!fingerprint) return null
      cache = { mtime, pem, fingerprint }
    }
    return { pem: cache.pem, fingerprint: cache.fingerprint }
  } catch {
    return null
  }
}

export const caFingerprint = (): string | undefined => brainCa()?.fingerprint
