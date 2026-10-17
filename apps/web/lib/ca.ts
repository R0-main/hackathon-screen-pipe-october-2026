// Self-hosted brain over local HTTPS: the certificate of its private authority (BRAIN_CA_FILE, in PEM) is served on
// /ca.crt and its SHA-256 fingerprint is pinned in the install prompts, so that each workstation checks what
// it downloads before trusting it. Without BRAIN_CA_FILE (cloud, public certificate): nothing changes.

import { X509Certificate } from "node:crypto"
import { readFileSync, statSync } from "node:fs"

type Loaded = { mtime: number; pem: string; fingerprint: string }
let cache: Loaded | null = null

/** SHA-256 fingerprint of the first certificate, uppercase hex without ":" (like `openssl x509 -fingerprint -sha256`). */
export function fingerprintOf(pem: string): string | null {
  const first = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(pem)?.[0]
  if (!first) return null
  try {
    return new X509Certificate(first).fingerprint256.replace(/:/g, "").toUpperCase()
  } catch {
    return null
  }
}

/** The configured certificate, re-read when the file changes; null if missing or not created yet (Caddy starting). */
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
