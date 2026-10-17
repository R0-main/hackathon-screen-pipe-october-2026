// Fills the brain with the fictional company Butine (accounts, zones, knowledge, activity history).
// Usage: npm run seed            (file storage, or Postgres if DATABASE_URL is set)
//        npm run seed -- --force (overwrites an existing brain)
// The data comes from lib/demo-seed.ts (the same bootstrap as the demo mode of a fresh deployment).

import fs from "node:fs"
import path from "node:path"
import { getStore } from "../lib/store"
import { seedDemoBrain } from "../lib/demo-seed"
import { DEMO_USERS } from "./demo-data"

/**
 * Tokens follow the seeded storage: a Postgres seed run from apps/web does not overwrite the tokens of the file
 * brain (.brain/demo-tokens.json), which would no longer match any account.
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
      console.error(`The brain already has ${existing.length} accounts. Run again with --force to overwrite everything.`)
      process.exitCode = 1
      return
    }

    console.log(`→ Resetting the brain (${store.kind})…`)
    const { tokens, counts } = await seedDemoBrain(store)

    const dir = path.resolve(process.env.BRAIN_DATA_DIR ?? ".brain")
    fs.mkdirSync(dir, { recursive: true })
    const tokenFile = path.join(dir, tokenFileName(store.kind))
    fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 })

    console.log(
      `✓ ${counts.users} accounts, ${counts.skills} skills, ${counts.items} knowledge items, ${counts.tasks} tasks, ${counts.events} events, ${counts.automations} automation(s) detected.`,
    )
    console.log(`\nDemo tokens (also in ${tokenFile}):`)
    for (const u of DEMO_USERS) console.log(`  ${u.name.padEnd(18)} ${u.role === "admin" ? "[admin]" : "       "} ${tokens[u.key].token}`)
  } finally {
    if ("end" in store && typeof (store as { end?: () => Promise<void> }).end === "function") await (store as { end: () => Promise<void> }).end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
