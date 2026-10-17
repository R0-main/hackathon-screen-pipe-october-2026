import { strict as assert } from "node:assert"
import { test } from "node:test"
import { isExecutableSkillFile, isSafeSkillPath, parseSkillFrontmatter, skillFileProblems, skillSecrets, skillSlug, withSkillFrontmatter } from "./skills"

test("skills: safe paths only (relative, no \"..\" and no hidden file)", () => {
  for (const p of ["SKILL.md", "scripts/export.py", "ref/a-b_c.v2.md"]) assert.ok(isSafeSkillPath(p), p)
  for (const p of ["", "/etc/passwd", "../x", "a/../b", "scripts/..", ".env", "a/.git/config", "a\\b", ".company-brain.json", "a/b/c/d/e/f/g"])
    assert.ok(!isSafeSkillPath(p), p)
})

test("skills: name taken from a title or a folder", () => {
  assert.equal(skillSlug("Month-end close (finance)"), "month-end-close-finance")
  assert.equal(skillSlug("  Deploy   Fournil  "), "deploy-fournil")
  assert.equal(skillSlug("Café menu"), "cafe-menu", "accents are stripped")
})

test("skills: the SKILL.md front matter takes the published name and description, other keys stay", () => {
  const md = "---\nname: old\ndescription: >\n  on two\n  lines\nallowed-tools: Bash, Read\n---\n\n# Title\n\nBody.\n"
  assert.equal(parseSkillFrontmatter(md).data.description, "on two lines")
  const out = withSkillFrontmatter(md, "new", "Describes  the\nskill well")
  const { data, body } = parseSkillFrontmatter(out)
  assert.equal(data.name, "new")
  assert.equal(data.description, "Describes the skill well")
  assert.equal(data["allowed-tools"], "Bash, Read")
  assert.ok(!out.includes("on two"), "the continuation lines of the old description go away")
  assert.equal(body, "\n# Title\n\nBody.\n")
  const bare = withSkillFrontmatter("# No front matter\n", "x", "Does x")
  assert.ok(bare.startsWith('---\nname: x\ndescription: "Does x"\n---\n\n# No front matter'))
})

test("skills: a secret in a script is flagged, a support email is not", () => {
  const key = ["sk-ant-", "api03-", "a".repeat(40)].join("")
  const found = skillSecrets([
    { path: "SKILL.md", content: "Write to support@fournil.example if you get stuck." },
    { path: "scripts/run.sh", content: `#!/bin/sh\ncurl -H "x-api-key: ${key}" https://api.example` },
    { path: "scripts/ok.sh", content: '#!/bin/sh\ncurl -H "x-api-key: $ANTHROPIC_API_KEY" https://api.example' },
  ])
  assert.deepEqual(found.map((f) => f.path), ["scripts/run.sh"])
})

test("skills: SKILL.md required, duplicates and sizes bounded; executable scripts", () => {
  assert.match(skillFileProblems([{ path: "run.sh", content: "" }]).join(), /SKILL\.md missing/)
  assert.match(skillFileProblems([{ path: "SKILL.md", content: "" }, { path: "skill.md", content: "" }]).join(), /Duplicate/)
  assert.deepEqual(skillFileProblems([{ path: "SKILL.md", content: "# ok" }]), [])
  assert.ok(isExecutableSkillFile({ path: "scripts/export.py", content: "print(1)" }))
  assert.ok(isExecutableSkillFile({ path: "tool", content: "#!/usr/bin/env node\n" }))
  assert.ok(!isExecutableSkillFile({ path: "reference.md", content: "# Notes" }))
})
