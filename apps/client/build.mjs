// Empaquette le client en un seul fichier ESM (brain.mjs), servi par le dashboard sur /brain.mjs.

import { build } from "esbuild"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "dist", "brain.mjs")
const publicOut = join(here, "..", "web", "public", "brain.mjs")
// Empreinte publiée à côté (/brain.mjs.sha256, format de sha256sum) : un poste peut vérifier ce qu'il a téléchargé.
const shaOut = `${publicOut}.sha256`

await build({
  entryPoints: [join(here, "src", "cli.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: true,
  legalComments: "none",
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "module"; const require = __cr(import.meta.url);',
  },
  logLevel: "warning",
})

chmodSync(out, 0o755)
mkdirSync(dirname(publicOut), { recursive: true })
copyFileSync(out, publicOut)
chmodSync(publicOut, 0o755)
const sha256 = createHash("sha256").update(readFileSync(publicOut)).digest("hex")
writeFileSync(shaOut, `${sha256}  brain.mjs\n`)
const kb = (f) => `${(statSync(f).size / 1024).toFixed(0)} Ko`
console.log(`brain.mjs construit : ${out} (${kb(out)}) → copié dans ${publicOut}`)
console.log(`SHA-256 : ${sha256} → ${shaOut}`)
