// Remplit le cerveau avec l'entreprise fictive Butine (comptes, zones, connaissances, historique d'activité).
// Usage : npm run seed            (stockage fichier, ou Postgres si DATABASE_URL est défini)
//         npm run seed -- --force (écrase un cerveau existant)
// Les données viennent de lib/demo-seed.ts (le même amorçage que le mode démo d'un déploiement neuf).

import fs from "node:fs"
import path from "node:path"
import { getStore } from "../lib/store"
import { seedDemoBrain } from "../lib/demo-seed"
import { DEMO_USERS } from "./demo-data"

/**
 * Les jetons suivent le stockage seedé : un seed Postgres lancé depuis apps/web n'écrase pas les jetons du cerveau
 * fichier (.brain/demo-tokens.json), qui ne correspondraient plus à aucun compte.
 */
function tokenFileName(kind: string): string {
  if (kind !== "postgres") return "demo-tokens.json"
  let db = "postgres"
  try {
    db = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "") || db
  } catch {}
  return `demo-tokens.postgres-${db.replace(/[^a-zA-Z0-9_-]+/g, "_")}.json`
}

async function main() {
  const force = process.argv.includes("--force")
  const store = getStore()
  try {
    const existing = await store.listProfiles()
    if (existing.length > 0 && !force) {
      console.error(`Le cerveau contient déjà ${existing.length} comptes. Relancez avec --force pour tout écraser.`)
      process.exitCode = 1
      return
    }

    console.log(`→ Réinitialisation du cerveau (${store.kind})…`)
    const { tokens, counts } = await seedDemoBrain(store)

    const dir = path.resolve(process.env.BRAIN_DATA_DIR ?? ".brain")
    fs.mkdirSync(dir, { recursive: true })
    const tokenFile = path.join(dir, tokenFileName(store.kind))
    fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 })

    console.log(
      `✓ ${counts.users} comptes, ${counts.skills} skills, ${counts.items} connaissances, ${counts.tasks} tâches, ${counts.events} événements, ${counts.automations} automatisation(s) détectée(s).`,
    )
    console.log(`\nJetons de démo (aussi dans ${tokenFile}) :`)
    for (const u of DEMO_USERS) console.log(`  ${u.name.padEnd(18)} ${u.role === "admin" ? "[admin]" : "       "} ${tokens[u.key].token}`)
  } finally {
    if ("end" in store && typeof (store as { end?: () => Promise<void> }).end === "function") await (store as { end: () => Promise<void> }).end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
