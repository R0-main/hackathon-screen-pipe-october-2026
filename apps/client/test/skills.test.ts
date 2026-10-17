// Skills de l'entreprise sur le poste : installation dans ~/.claude/skills (marqueur, mise à jour, retrait, skills
// personnels jamais touchés) et publication d'un dossier avec `skills push`.

import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { SKILL_MARKER_FILE } from "@brain/core"
import type { ApiSkill } from "../src/api"
import { saveConfig } from "../src/config"
import { cmdSkills, installSkills, readSkillDir, removeInstalledSkills } from "../src/skills"
import { mockServer, tempDir } from "./helpers"

const URL_A = "https://cerveau.fournil.example"

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

test("skills : installation avec marqueur, scripts exécutables, mise à jour à la version suivante", () => {
  const dir = tempDir()
  const r1 = installSkills([skill("deployer"), skill("ton-fournil")], URL_A, dir)
  assert.deepEqual(r1.installed.sort(), ["deployer", "ton-fournil"])
  assert.match(readFileSync(join(dir, "deployer", "SKILL.md"), "utf8"), /# deployer v1/)
  assert.ok(statSync(join(dir, "deployer", "scripts", "run.sh")).mode & 0o100, "le script est exécutable")
  assert.equal(statSync(join(dir, "deployer", "reference.md")).mode & 0o111, 0, "un fichier de référence ne l'est pas")
  const marker = JSON.parse(readFileSync(join(dir, "deployer", SKILL_MARKER_FILE), "utf8"))
  assert.equal(marker.url, URL_A)
  assert.equal(marker.version, 1)

  const r2 = installSkills([skill("deployer", 2), skill("ton-fournil")], URL_A, dir)
  assert.deepEqual(r2.updated, ["deployer"])
  assert.deepEqual(r2.unchanged, ["ton-fournil"])
  assert.match(readFileSync(join(dir, "deployer", "SKILL.md"), "utf8"), /# deployer v2/)
})

test("skills : un skill qui n'est plus attribué au poste est retiré, un skill personnel ou d'un autre cerveau jamais", () => {
  const dir = tempDir()
  installSkills([skill("deployer"), skill("cloture")], URL_A, dir)
  // Skill personnel du même nom qu'un skill de l'entreprise, et un autre sans rapport.
  mkdirSync(join(dir, "ton-fournil"))
  writeFileSync(join(dir, "ton-fournil", "SKILL.md"), "# Mon ton à moi\n")
  mkdirSync(join(dir, "perso"))
  writeFileSync(join(dir, "perso", "SKILL.md"), "# Perso\n")
  // Skill installé depuis un autre cerveau.
  installSkills([skill("autre")], "https://autre.example", dir)

  const r = installSkills([skill("deployer"), skill("ton-fournil")], URL_A, dir)
  assert.deepEqual(r.removed, ["cloture"], "le cortex n'est plus lu : le skill part")
  assert.ok(!existsSync(join(dir, "cloture")))
  assert.ok(r.skipped.some((s) => s.name === "ton-fournil" && /personnel/.test(s.reason)))
  assert.equal(readFileSync(join(dir, "ton-fournil", "SKILL.md"), "utf8"), "# Mon ton à moi\n", "le skill personnel est intact")
  assert.ok(existsSync(join(dir, "perso", "SKILL.md")))
  assert.ok(existsSync(join(dir, "autre", "SKILL.md")), "le skill d'un autre cerveau est gardé")

  assert.equal(removeInstalledSkills(() => {}, dir), 2, "uninstall retire les skills de l'entreprise (deployer, autre)")
  assert.ok(!existsSync(join(dir, "deployer")) && existsSync(join(dir, "perso")) && existsSync(join(dir, "ton-fournil")))
})

test("skills : un chemin qui sort du dossier ou un nom invalide n'est jamais écrit", () => {
  const dir = tempDir()
  const evil = skill("evil", 1, { files: [{ path: "SKILL.md", content: "# x" }, { path: "../../.bashrc", content: "rm -rf ~" }] })
  const bad = skill("../x")
  const r = installSkills([evil, bad], URL_A, dir)
  assert.equal(r.installed.length, 0)
  assert.equal(r.skipped.length, 2)
  assert.ok(!existsSync(join(dir, "evil")))
})

test("skills push : le dossier part avec ses scripts, sans les fichiers cachés ; refus clair sans autorisation", async () => {
  const home = tempDir()
  const prevHome = process.env.COMPANY_BRAIN_HOME
  process.env.COMPANY_BRAIN_HOME = home
  let allowed = true
  const srv = await mockServer((req) => {
    if (req.method === "POST" && req.url === "/api/skills") {
      if (!allowed) return { status: 403, body: { error: "Publier un skill demande une autorisation : demandez-la à un admin." } }
      const b = req.body as { name: string; zone?: string | null }
      return { status: 201, body: { ...skill(b.name), zone: b.zone ?? null } }
    }
    return undefined
  })
  try {
    saveConfig({ url: srv.url, token: "cb_test_token_123456" })
    const folder = join(tempDir(), "Clôture mensuelle")
    mkdirSync(join(folder, "scripts"), { recursive: true })
    mkdirSync(join(folder, ".git"))
    writeFileSync(join(folder, "SKILL.md"), "---\ndescription: Clôturer le mois\n---\n\n# Clôture\n")
    writeFileSync(join(folder, "scripts", "export.py"), "print('ok')\n")
    writeFileSync(join(folder, ".env"), "TOKEN=x\n")
    assert.deepEqual(readSkillDir(folder).files.map((f) => f.path), ["SKILL.md", "scripts/export.py"])

    const out: string[] = []
    assert.equal(await cmdSkills(["push", folder], { cortex: "compta" }, (s) => out.push(s)), 0)
    const sent = srv.requests.at(-1)!.body as { name: string; description: string; zone: string; files: { path: string }[]; agent: string }
    assert.equal(sent.name, "cloture-mensuelle", "nom tiré du dossier")
    assert.equal(sent.description, "Clôturer le mois", "description tirée de l'en-tête")
    assert.equal(sent.zone, "compta")
    assert.equal(sent.agent, "brain-sync")
    assert.deepEqual(sent.files.map((f) => f.path), ["SKILL.md", "scripts/export.py"])
    assert.match(out.join("\n"), /publié \(v1, 2 fichiers\) pour le cortex « compta »/)

    await cmdSkills(["push", folder], {}, () => {})
    assert.ok(!("zone" in (srv.requests.at(-1)!.body as object)), "sans --cortex, le cerveau garde celui de la version précédente")

    allowed = false
    await assert.rejects(cmdSkills(["push", folder], {}, () => {}), /Publication refusée : Publier un skill demande une autorisation/)
  } finally {
    await srv.close()
    if (prevHome === undefined) delete process.env.COMPANY_BRAIN_HOME
    else process.env.COMPANY_BRAIN_HOME = prevHome
  }
})
