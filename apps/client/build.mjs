// Bundles the client into a single ESM file (brain.mjs), served by the dashboard on /brain.mjs.

import { build } from "esbuild"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "dist", "brain.mjs")
const publicOut = join(here, "..", "web", "public", "brain.mjs")
// Fingerprint published alongside (/brain.mjs.sha256, sha256sum format): a computer can check what it downloaded.
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
console.log(`brain.mjs built: ${out} (${kb(out)}) → copied to ${publicOut}`)
console.log(`SHA-256 : ${sha256} → ${shaOut}`)
