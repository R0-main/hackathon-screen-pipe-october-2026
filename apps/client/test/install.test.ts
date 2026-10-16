import { strict as assert } from "node:assert"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import {
  cronLine,
  hookCommand,
  hooksInstalled,
  installHooks,
  launchdPlist,
  mergeCrontab,
  mergeHooks,
  removeFromCrontab,
  removeHooks,
  uninstallHooks,
  windowsTaskArgs,
} from "../src/install"
import { tempDir } from "./helpers"

const CMD = hookCommand("/usr/bin/node", "/home/u/.company-brain/brain.mjs")

const foreign = {
  model: "opus",
  permissions: { allow: ["Bash(npm test)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "say fini" }] }],
  },
}

test("mergeHooks : ajoute nos 3 hooks, garde les hooks étrangers et l'ordre, idempotent", () => {
  const { settings, changes } = mergeHooks(foreign, CMD)
  assert.equal(changes.length, 3)
  assert.deepEqual(Object.keys(settings), ["model", "permissions", "hooks"])
  const hooks = settings.hooks as Record<string, { hooks: { command: string; timeout?: number }[] }[]>
  assert.equal(hooks.PreToolUse[0].hooks[0].command, "./guard.sh")
  assert.equal(hooks.Stop[0].hooks[0].command, "say fini")
  assert.equal(hooks.Stop[1].hooks[0].command, CMD)
  assert.equal(hooks.UserPromptSubmit[0].hooks[0].command, CMD)
  assert.equal(hooks.SessionStart[0].hooks[0].timeout, 5)
  assert.equal(CMD, '"/usr/bin/node" "/home/u/.company-brain/brain.mjs" hook')

  const again = mergeHooks(settings, CMD)
  assert.deepEqual(again.changes, [])
  assert.deepEqual(again.settings, settings)

  // Le chemin du script change : la commande est mise à jour, pas dupliquée.
  const moved = mergeHooks(settings, hookCommand("/opt/node", "/new/brain.mjs"))
  assert.equal(moved.changes.length, 3)
  const mh = moved.settings.hooks as Record<string, { hooks: { command: string }[] }[]>
  assert.equal(mh.Stop.length, 2)
  assert.equal(mh.Stop[1].hooks[0].command, '"/opt/node" "/new/brain.mjs" hook')
})

test("removeHooks : retire seulement nos hooks", () => {
  const { settings } = mergeHooks(foreign, CMD)
  const { settings: cleaned, removed } = removeHooks(settings)
  assert.equal(removed, 3)
  assert.deepEqual(cleaned, foreign)
  assert.deepEqual(removeHooks({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: CMD }] }] } }).settings, {})
})

test("installHooks / uninstallHooks sur un vrai fichier : sauvegarde, idempotence, désinstallation", () => {
  const dir = tempDir()
  process.env.COMPANY_BRAIN_SCRIPT = join(dir, "brain.mjs")
  const file = join(dir, "settings.json")
  writeFileSync(file, JSON.stringify(foreign, null, 2))
  const logs: string[] = []
  const r1 = installHooks((s) => logs.push(s), file)
  assert.equal(r1.changes.length, 3)
  assert.ok(r1.backup && readdirSync(dir).some((f) => f.startsWith("settings.json.bak-")))
  assert.ok(hooksInstalled(file))
  const r2 = installHooks((s) => logs.push(s), file)
  assert.equal(r2.changes.length, 0)
  assert.equal(uninstallHooks(() => {}, file), 3)
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), foreign)
  assert.ok(!hooksInstalled(file))
})

test("installHooks : refuse un settings.json invalide sans l'écraser", () => {
  const dir = tempDir()
  const file = join(dir, "settings.json")
  writeFileSync(file, "{ pas du json")
  assert.throws(() => installHooks(() => {}, file), /pas un JSON valide/)
  assert.equal(readFileSync(file, "utf8"), "{ pas du json")
})

test("crontab : ligne idempotente, autres lignes conservées, retrait", () => {
  const line = cronLine("/usr/bin/node", "/home/u/.company-brain/brain.mjs", "/home/u/.company-brain")
  assert.equal(line, '*/15 * * * * "/usr/bin/node" "/home/u/.company-brain/brain.mjs" sync >> "/home/u/.company-brain/sync.log" 2>&1')
  const existing = "MAILTO=\"\"\n0 3 * * * /usr/local/bin/backup\n"
  const a = mergeCrontab(existing, line)
  assert.equal(a.changed, true)
  assert.equal(a.text, `${existing}${line}\n`)
  assert.equal(mergeCrontab(a.text, line).changed, false)
  const moved = mergeCrontab(a.text, cronLine("/opt/node", "/x/brain.mjs", "/x"))
  assert.equal(moved.text.split("\n").filter((l) => l.includes("brain.mjs")).length, 1)
  const r = removeFromCrontab(a.text)
  assert.equal(r.removed, 1)
  assert.equal(r.text, existing)
  assert.equal(mergeCrontab("", line).text, `${line}\n`)
})

test("launchd et schtasks : contenu généré", () => {
  const plist = launchdPlist("/usr/local/bin/node", "/Users/u/.company-brain/brain.mjs", "/Users/u/.company-brain")
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/)
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/Users\/u\/.company-brain\/brain.mjs<\/string>\s*<string>sync<\/string>/)
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Users\/u\/.company-brain\/sync.log<\/string>/)
  assert.match(plist, /com\.company-brain\.sync/)
  const args = windowsTaskArgs("C:\\node\\node.exe", "C:\\Users\\u\\.company-brain\\brain.mjs")
  assert.deepEqual(args.slice(0, 7), ["/Create", "/SC", "MINUTE", "/MO", "15", "/TN", "CompanyBrainSync"])
  assert.equal(args[8], '"C:\\node\\node.exe" "C:\\Users\\u\\.company-brain\\brain.mjs" sync')
})
