import { strict as assert } from "node:assert"
import { test } from "node:test"
import { isExecutableSkillFile, isSafeSkillPath, parseSkillFrontmatter, skillFileProblems, skillSecrets, skillSlug, withSkillFrontmatter } from "./skills"

test("skills : chemins sûrs seulement (relatifs, sans « .. » ni fichier caché)", () => {
  for (const p of ["SKILL.md", "scripts/export.py", "ref/a-b_c.v2.md"]) assert.ok(isSafeSkillPath(p), p)
  for (const p of ["", "/etc/passwd", "../x", "a/../b", "scripts/..", ".env", "a/.git/config", "a\\b", ".company-brain.json", "a/b/c/d/e/f/g"])
    assert.ok(!isSafeSkillPath(p), p)
})

test("skills : nom tiré d'un titre ou d'un dossier", () => {
  assert.equal(skillSlug("Clôture mensuelle (compta)"), "cloture-mensuelle-compta")
  assert.equal(skillSlug("  Déployer   Fournil  "), "deployer-fournil")
})

test("skills : l'en-tête de SKILL.md prend le nom et la description publiés, les autres clés restent", () => {
  const md = "---\nname: ancien\ndescription: >\n  sur deux\n  lignes\nallowed-tools: Bash, Read\n---\n\n# Titre\n\nCorps.\n"
  assert.equal(parseSkillFrontmatter(md).data.description, "sur deux lignes")
  const out = withSkillFrontmatter(md, "nouveau", "Décrit  bien\nle skill")
  const { data, body } = parseSkillFrontmatter(out)
  assert.equal(data.name, "nouveau")
  assert.equal(data.description, "Décrit bien le skill")
  assert.equal(data["allowed-tools"], "Bash, Read")
  assert.ok(!out.includes("sur deux"), "les lignes de suite de l'ancienne description partent")
  assert.equal(body, "\n# Titre\n\nCorps.\n")
  const bare = withSkillFrontmatter("# Sans en-tête\n", "x", "Fait x")
  assert.ok(bare.startsWith('---\nname: x\ndescription: "Fait x"\n---\n\n# Sans en-tête'))
})

test("skills : un secret dans un script est signalé, un email de support non", () => {
  const key = ["sk-ant-", "api03-", "a".repeat(40)].join("")
  const found = skillSecrets([
    { path: "SKILL.md", content: "Écrire à support@fournil.example si ça bloque." },
    { path: "scripts/run.sh", content: `#!/bin/sh\ncurl -H "x-api-key: ${key}" https://api.example` },
    { path: "scripts/ok.sh", content: '#!/bin/sh\ncurl -H "x-api-key: $ANTHROPIC_API_KEY" https://api.example' },
  ])
  assert.deepEqual(found.map((f) => f.path), ["scripts/run.sh"])
})

test("skills : SKILL.md obligatoire, doublons et tailles bornées ; scripts exécutables", () => {
  assert.match(skillFileProblems([{ path: "run.sh", content: "" }]).join(), /SKILL\.md manquant/)
  assert.match(skillFileProblems([{ path: "SKILL.md", content: "" }, { path: "skill.md", content: "" }]).join(), /double/)
  assert.deepEqual(skillFileProblems([{ path: "SKILL.md", content: "# ok" }]), [])
  assert.ok(isExecutableSkillFile({ path: "scripts/export.py", content: "print(1)" }))
  assert.ok(isExecutableSkillFile({ path: "outil", content: "#!/usr/bin/env node\n" }))
  assert.ok(!isExecutableSkillFile({ path: "reference.md", content: "# Notes" }))
})
