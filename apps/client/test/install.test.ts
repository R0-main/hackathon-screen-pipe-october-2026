import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { applyScheduleEnv, type State } from "../src/config"
import {
  baselineSources,
  cronLine,
  hookCommand,
  hooksInstalled,
  installHooks,
  launchdPlist,
  mergeCrontab,
  mergeHooks,
  prepareSchedule,
  removeFromCrontab,
  removeHooks,
  scheduleEnv,
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
  assert.equal(line, '*/15 * * * * "/usr/bin/node" "/home/u/.company-brain/brain.mjs" sync --scheduled >> "/home/u/.company-brain/sync.log" 2>&1')
  const existing = "MAILTO=\"\"\n0 3 * * * /usr/local/bin/backup\n"
  const a = mergeCrontab(existing, line)
  assert.equal(a.changed, true)
  assert.equal(a.text, `${existing}${line}\n`)
  assert.equal(mergeCrontab(a.text, line).changed, false)
  const moved = mergeCrontab(a.text, cronLine("/opt/node", "/x/brain.mjs", "/x", { PATH: "/opt/node:/usr/bin" }))
  assert.equal(moved.text.split("\n").filter((l) => l.includes("brain.mjs")).length, 1)
  const r = removeFromCrontab(a.text)
  assert.equal(r.removed, 1)
  assert.equal(r.text, existing)
  assert.equal(mergeCrontab("", line).text, `${line}\n`)
  // L'ancienne ligne (sans --scheduled ni environnement) est remplacée, pas dupliquée.
  const old = '*/15 * * * * "/usr/bin/node" "/home/u/.company-brain/brain.mjs" sync >> "/home/u/.company-brain/sync.log" 2>&1\n'
  assert.equal(mergeCrontab(old, line).text, `${line}\n`)
})

test("crontab : l'environnement relevé à l'installation est transmis (PATH, dossiers), guillemets et % échappés", () => {
  const line = cronLine("/usr/bin/node", "/h/brain.mjs", "/h", { PATH: "/opt/node/bin:/home/u/.local/bin", CLAUDE_CONFIG_DIR: "/home/u/mon dossier", CODEX_HOME: "/x'y%z" })
  assert.equal(
    line,
    `*/15 * * * * PATH='/opt/node/bin:/home/u/.local/bin' CLAUDE_CONFIG_DIR='/home/u/mon dossier' CODEX_HOME='/x'\\''y\\%z' "/usr/bin/node" "/h/brain.mjs" sync --scheduled >> "/h/sync.log" 2>&1`,
  )
})

test("crontab : exécutée comme par cron (env minimal), la commande voit PATH et les dossiers personnalisés", { skip: process.platform === "win32" }, () => {
  const dir = tempDir()
  const script = join(dir, "brain.mjs")
  // Faux brain.mjs : écrit l'environnement reçu dans le journal.
  writeFileSync(
    script,
    "console.log(JSON.stringify({ path: process.env.PATH, claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME, home: process.env.COMPANY_BRAIN_HOME, argv: process.argv.slice(2) }))\n",
  )
  const bin = join(dir, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho claude\n")
  chmodSync(join(bin, "claude"), 0o755)
  const env = scheduleEnv({ PATH: `${bin}${delimiter}/usr/bin${delimiter}relatif`, CLAUDE_CONFIG_DIR: join(dir, "claude cfg"), CODEX_HOME: join(dir, "codex") }, process.execPath, dir)
  const line = cronLine(process.execPath, script, dir, env)
  const cmd = line.replace(/^(\S+\s+){5}/, "").replace(/\\%/g, "%")
  const r = spawnSync("/bin/sh", ["-c", cmd], { env: { HOME: dir, PATH: "/usr/bin:/bin" }, encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  const got = JSON.parse(readFileSync(join(dir, "sync.log"), "utf8").trim())
  assert.deepEqual(got.argv, ["sync", "--scheduled"])
  assert.equal(got.claude, join(dir, "claude cfg"))
  assert.equal(got.codex, join(dir, "codex"))
  assert.equal(got.home, dir)
  const pathDirs = String(got.path).split(delimiter)
  assert.ok(pathDirs.includes(bin), "le dossier de `claude` doit être dans le PATH de la tâche")
  assert.ok(!pathDirs.includes("relatif"))
})

test("scheduleEnv : PATH absolu (node, claude, PATH courant), dossiers seulement s'ils sont définis", () => {
  const env = scheduleEnv({ PATH: `/usr/local/bin${delimiter}.${delimiter}/usr/bin` }, "/opt/node22/bin/node", "/h")
  assert.equal(env.PATH.split(delimiter)[0], "/opt/node22/bin")
  assert.ok(!env.PATH.split(delimiter).includes("."))
  assert.equal(env.COMPANY_BRAIN_HOME, "/h")
  assert.ok(!("CLAUDE_CONFIG_DIR" in env) && !("CODEX_HOME" in env))
})

test("applyScheduleEnv : complète l'environnement sans écraser, fusionne le PATH", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", CODEX_HOME: "/deja" }
  applyScheduleEnv({ schedule_env: { PATH: "/opt/node/bin:/usr/bin", CLAUDE_CONFIG_DIR: "/cfg", CODEX_HOME: "/autre" } }, env)
  assert.equal(env.PATH, ["/usr/bin", "/bin", "/opt/node/bin"].join(delimiter))
  assert.equal(env.CLAUDE_CONFIG_DIR, "/cfg")
  assert.equal(env.CODEX_HOME, "/deja")
})

test("prepareSchedule : la synchro planifiée part de maintenant (baseline) et l'environnement est noté dans la config", () => {
  const home = tempDir()
  const prev = process.env.COMPANY_BRAIN_HOME
  const prevDirs = [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]
  process.env.COMPANY_BRAIN_HOME = home
  process.env.CLAUDE_CONFIG_DIR = tempDir()
  process.env.CODEX_HOME = tempDir()
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ url: "http://x", token: "cb_test_token_123456" }))
    writeFileSync(join(home, "state.json"), JSON.stringify({ claude: { files: { "/a.jsonl": { offset: 10, size: 10, mtime: 1 } } } }))
    const before = Date.now()
    const logs: string[] = []
    prepareSchedule({ PATH: "/usr/bin", COMPANY_BRAIN_HOME: home }, (s) => logs.push(s))
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"))
    assert.ok(Date.parse(state.baseline_at) >= before)
    assert.deepEqual(state.claude.files["/a.jsonl"], { offset: 10, size: 10, mtime: 1 })
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
    assert.deepEqual(cfg.schedule_env, { PATH: "/usr/bin", COMPANY_BRAIN_HOME: home })
    assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600)
    assert.match(logs.join("\n"), /part de maintenant/)
  } finally {
    if (prev === undefined) delete process.env.COMPANY_BRAIN_HOME
    else process.env.COMPANY_BRAIN_HOME = prev
    for (const [k, v] of [["CLAUDE_CONFIG_DIR", prevDirs[0]], ["CODEX_HOME", prevDirs[1]]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test("PRIVACY-8b baselineSources : Screenpipe à maintenant, tous les fichiers Claude / Codex à leur fin, sessions internes repérées", () => {
  const claude = tempDir()
  const codex = tempDir()
  const proj = join(claude, "projects", "p")
  const day = join(codex, "sessions", "2026", "10", "16")
  mkdirSync(proj, { recursive: true })
  mkdirSync(join(proj, "subagents"), { recursive: true })
  mkdirSync(day, { recursive: true })
  const l = (o: unknown) => JSON.stringify(o) + "\n"
  const known = join(proj, "known.jsonl")
  const fresh = join(proj, "fresh.jsonl")
  const install = join(proj, "install.jsonl")
  const partial = join(day, "rollout-a.jsonl")
  writeFileSync(known, l({ type: "user", message: { role: "user", content: "a" } }) + l({ type: "user", message: { role: "user", content: "b" } }))
  writeFileSync(fresh, l({ type: "user", message: { role: "user", content: "c" } }))
  writeFileSync(install, l({ type: "user", message: { role: "user", content: "Tu vas connecter ce poste au cerveau d'entreprise de Fournil." } }) + l({ type: "assistant", message: { role: "assistant", content: "OK" } }))
  const done = l({ type: "response_item", payload: { type: "message", role: "user", content: "q" } })
  writeFileSync(partial, done + '{"type":"response_item","payload":{"type":"mess')
  writeFileSync(join(proj, "subagents", "s.jsonl"), l({ type: "user" }))
  const state: State = { claude: { files: { [known]: { offset: 3, size: 3, mtime: 1 } } }, screenpipe: { last_timestamp: "2026-10-10T00:00:00.000Z", span_ms: 60000 } }
  const at = new Date()
  const r = baselineSources(state, at, { claudeDir: claude, codexDir: codex, secrets: [], brainHome: "/nulle-part" })
  assert.equal(state.baseline_at, at.toISOString())
  assert.equal(state.screenpipe?.last_timestamp, at.toISOString())
  assert.equal(state.screenpipe?.span_ms, 60000)
  assert.equal(state.claude?.files[known].offset, statSync(known).size)
  assert.equal(state.claude?.files[fresh].offset, statSync(fresh).size)
  assert.equal(state.claude?.files[install].internal, true)
  assert.equal(state.claude?.files[fresh].internal, undefined)
  // Dernière ligne en cours d'écriture : l'offset s'arrête avant elle.
  assert.equal(state.codex?.files[partial].offset, Buffer.byteLength(done))
  assert.equal(Object.keys(state.claude?.files ?? {}).some((f) => f.includes("subagents")), false)
  assert.deepEqual(r, { files: 4, internal: 1 })
  // Un checkpoint Screenpipe déjà plus récent n'est pas reculé.
  const later: State = { screenpipe: { last_timestamp: "2999-01-01T00:00:00.000Z" } }
  baselineSources(later, at, { claudeDir: tempDir(), codexDir: tempDir() })
  assert.equal(later.screenpipe?.last_timestamp, "2999-01-01T00:00:00.000Z")
})

test("F-claude-token : le jeton Claude Code n'est jamais écrit dans le crontab, le plist ni schedule_env", () => {
  const token = ["sk-ant-", "oat01-", "Zq9", "y".repeat(40)].join("")
  const env = scheduleEnv({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: token }, "/usr/local/bin/node", "/h/.company-brain")
  assert.deepEqual(Object.keys(env).sort(), ["COMPANY_BRAIN_HOME", "PATH"])
  const cron = cronLine("/usr/local/bin/node", "/h/brain.mjs", "/h/.company-brain", env)
  const plist = launchdPlist("/usr/local/bin/node", "/h/brain.mjs", "/h/.company-brain", env)
  for (const text of [cron, plist, JSON.stringify(env)]) {
    assert.ok(!text.includes(token))
    assert.ok(!text.includes("CLAUDE_CODE_OAUTH_TOKEN"))
  }
})

test("launchd et schtasks : contenu généré (pas de lancement au chargement, environnement transmis)", () => {
  const plist = launchdPlist("/usr/local/bin/node", "/Users/u/.company-brain/brain.mjs", "/Users/u/.company-brain", {
    PATH: "/usr/local/bin:/Users/u/.local/bin:/usr/bin",
    CLAUDE_CONFIG_DIR: "/Users/u/claude & co",
  })
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/)
  assert.ok(!plist.includes("<true/>"))
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/Users\/u\/.company-brain\/brain.mjs<\/string>\s*<string>sync<\/string>\s*<string>--scheduled<\/string>/)
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Users\/u\/.company-brain\/sync.log<\/string>/)
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:\/Users\/u\/.local\/bin:\/usr\/bin<\/string>/)
  assert.match(plist, /<key>CLAUDE_CONFIG_DIR<\/key>\s*<string>\/Users\/u\/claude &amp; co<\/string>/)
  assert.match(plist, /<key>COMPANY_BRAIN_HOME<\/key>\s*<string>\/Users\/u\/.company-brain<\/string>/)
  assert.match(plist, /com\.company-brain\.sync/)
  const args = windowsTaskArgs("C:\\node\\node.exe", "C:\\Users\\u\\.company-brain\\brain.mjs")
  assert.deepEqual(args.slice(0, 7), ["/Create", "/SC", "MINUTE", "/MO", "15", "/TN", "CompanyBrainSync"])
  assert.equal(args[8], '"C:\\node\\node.exe" "C:\\Users\\u\\.company-brain\\brain.mjs" sync --scheduled')
  const custom = windowsTaskArgs("C:\\node\\node.exe", "C:\\b\\brain.mjs", "D:\\cerveau")
  assert.equal(custom[8], '"C:\\node\\node.exe" "C:\\b\\brain.mjs" sync --scheduled --home "D:\\cerveau"')
  assert.ok(custom[8].length <= 261)
})
