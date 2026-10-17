// Company skills on the computer: install in ~/.claude/skills (marker, update, removal, personal skills never
// touched) and publishing a folder with `skills push`.

import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { SKILL_MARKER_FILE } from "@brain/core"
import type { ApiSkill } from "../src/api"
import { saveConfig } from "../src/config"
import { cmdSkills, installSkills, readSkillDir, removeInstalledSkills } from "../src/skills"
import { mockServer, tempDir } from "./helpers"

const URL_A = "https://brain.fournil.example"

function skill(name: string, version = 1, extra: Partial<ApiSkill> = {}): ApiSkill {
  return {
    id: `id-${name}`,
    name,
    description: `Skill ${name}`,
    zone: null,
    files: [
      { path: "SKILL.md", content: `---\nname: ${name}\ndescription: "Skill ${name}"\n---\n\n# ${name} v${version}\n` },
      { path: "scripts/run.sh", content: "#!/usr/bin/env bash\necho ok\n" },
      { path: "reference.md", content: "Notes.\n" },
    ],
    author_id: "u1",
    updated_by: "u1",
    version,
    created_at: "2026-10-10T10:00:00Z",
    updated_at: "2026-10-10T10:00:00Z",
    ...extra,
  }
}

test("skills: install with a marker, executable scripts, update to the next version", () => {
  const dir = tempDir()
  const r1 = installSkills([skill("deployer"), skill("fournil-tone")], URL_A, dir)
  assert.deepEqual(r1.installed.sort(), ["deployer", "fournil-tone"])
  assert.match(readFileSync(join(dir, "deployer", "SKILL.md"), "utf8"), /# deployer v1/)
  assert.ok(statSync(join(dir, "deployer", "scripts", "run.sh")).mode & 0o100, "the script is executable")
  assert.equal(statSync(join(dir, "deployer", "reference.md")).mode & 0o111, 0, "a reference file is not")
  const marker = JSON.parse(readFileSync(join(dir, "deployer", SKILL_MARKER_FILE), "utf8"))
  assert.equal(marker.url, URL_A)
  assert.equal(marker.version, 1)

  const r2 = installSkills([skill("deployer", 2), skill("fournil-tone")], URL_A, dir)
  assert.deepEqual(r2.updated, ["deployer"])
  assert.deepEqual(r2.unchanged, ["fournil-tone"])
  assert.match(readFileSync(join(dir, "deployer", "SKILL.md"), "utf8"), /# deployer v2/)
})

test("skills: a skill no longer assigned to the computer is removed, a personal skill or one from another brain never", () => {
  const dir = tempDir()
  installSkills([skill("deployer"), skill("closing")], URL_A, dir)
  // Personal skill with the same name as a company skill, and another unrelated one.
  mkdirSync(join(dir, "fournil-tone"))
  writeFileSync(join(dir, "fournil-tone", "SKILL.md"), "# My own tone\n")
  mkdirSync(join(dir, "personal"))
  writeFileSync(join(dir, "personal", "SKILL.md"), "# Personal\n")
  // Skill installed from another brain.
  installSkills([skill("other")], "https://other.example", dir)

  const r = installSkills([skill("deployer"), skill("fournil-tone")], URL_A, dir)
  assert.deepEqual(r.removed, ["closing"], "the cortex is no longer readable: the skill goes")
  assert.ok(!existsSync(join(dir, "closing")))
  assert.ok(r.skipped.some((s) => s.name === "fournil-tone" && /personal/.test(s.reason)))
  assert.equal(readFileSync(join(dir, "fournil-tone", "SKILL.md"), "utf8"), "# My own tone\n", "the personal skill is intact")
  assert.ok(existsSync(join(dir, "personal", "SKILL.md")))
  assert.ok(existsSync(join(dir, "other", "SKILL.md")), "the skill from another brain is kept")

  assert.equal(removeInstalledSkills(() => {}, dir), 2, "uninstall removes the company skills (deployer, other)")
  assert.ok(!existsSync(join(dir, "deployer")) && existsSync(join(dir, "personal")) && existsSync(join(dir, "fournil-tone")))
})

test("skills: a path that leaves the folder or an invalid name is never written", () => {
  const dir = tempDir()
  const evil = skill("evil", 1, { files: [{ path: "SKILL.md", content: "# x" }, { path: "../../.bashrc", content: "rm -rf ~" }] })
  const bad = skill("../x")
  const r = installSkills([evil, bad], URL_A, dir)
  assert.equal(r.installed.length, 0)
  assert.equal(r.skipped.length, 2)
  assert.ok(!existsSync(join(dir, "evil")))
})

test("skills push: the folder goes with its scripts, without the hidden files; clear refusal without permission", async () => {
  const home = tempDir()
  const prevHome = process.env.COMPANY_BRAIN_HOME
  process.env.COMPANY_BRAIN_HOME = home
  let allowed = true
  const srv = await mockServer((req) => {
    if (req.method === "POST" && req.url === "/api/skills") {
      if (!allowed) return { status: 403, body: { error: "Publishing a skill needs a permission: ask an admin for it." } }
      const b = req.body as { name: string; zone?: string | null }
      return { status: 201, body: { ...skill(b.name), zone: b.zone ?? null } }
    }
    return undefined
  })
  try {
    saveConfig({ url: srv.url, token: "cb_test_token_123456" })
    const folder = join(tempDir(), "Monthly closing")
    mkdirSync(join(folder, "scripts"), { recursive: true })
    mkdirSync(join(folder, ".git"))
    writeFileSync(join(folder, "SKILL.md"), "---\ndescription: Close the month\n---\n\n# Closing\n")
    writeFileSync(join(folder, "scripts", "export.py"), "print('ok')\n")
    writeFileSync(join(folder, ".env"), "TOKEN=x\n")
    assert.deepEqual(readSkillDir(folder).files.map((f) => f.path), ["SKILL.md", "scripts/export.py"])

    const out: string[] = []
    assert.equal(await cmdSkills(["push", folder], { cortex: "finance" }, (s) => out.push(s)), 0)
    const sent = srv.requests.at(-1)!.body as { name: string; description: string; zone: string; files: { path: string }[]; agent: string }
    assert.equal(sent.name, "monthly-closing", "name taken from the folder")
    assert.equal(sent.description, "Close the month", "description taken from the header")
    assert.equal(sent.zone, "finance")
    assert.equal(sent.agent, "brain-sync")
    assert.deepEqual(sent.files.map((f) => f.path), ["SKILL.md", "scripts/export.py"])
    assert.match(out.join("\n"), /published \(v1, 2 files\) for the "finance" cortex/)

    await cmdSkills(["push", folder], {}, () => {})
    assert.ok(!("zone" in (srv.requests.at(-1)!.body as object)), "without --cortex, the brain keeps the one of the previous version")

    allowed = false
    await assert.rejects(cmdSkills(["push", folder], {}, () => {}), /Publishing refused: Publishing a skill needs a permission/)
  } finally {
    await srv.close()
    if (prevHome === undefined) delete process.env.COMPANY_BRAIN_HOME
    else process.env.COMPANY_BRAIN_HOME = prevHome
  }
})
