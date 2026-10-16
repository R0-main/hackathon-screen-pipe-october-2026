import { strict as assert } from "node:assert"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { PIPE_NAME, installPipe, pipeInstalled, pipeMarkdown, pipePath, uninstallPipe } from "../src/install"
import { tempDir } from "./helpers"

test("pipe Screenpipe brain-sync : frontmatter borné, commande sync --scheduled, installation et retrait", () => {
  const dir = tempDir("brain-pipe-")
  process.env.COMPANY_BRAIN_SCREENPIPE_DIR = dir
  try {
    const md = pipeMarkdown("/usr/bin/node", "/home/x/.company-brain/brain.mjs", "/home/x/.company-brain")
    assert.match(md, /^---\nschedule: every 15m\nenabled: true\n/)
    assert.match(md, /trigger:\n  events:\n    - meeting_ended/)
    assert.match(md, /privacy_filter: true/)
    assert.match(md, /- Api\(GET \/meetings\)/)
    assert.match(md, /"\/home\/x\/\.company-brain\/brain\.mjs" sync --scheduled --home "\/home\/x\/\.company-brain"/)
    assert.ok(!/POST/.test(md), "aucune écriture autorisée")

    const logs: string[] = []
    const file = installPipe((s) => logs.push(s))
    assert.equal(file, join(dir, "pipes", PIPE_NAME, "pipe.md"))
    assert.equal(file, pipePath())
    assert.ok(existsSync(file))
    assert.ok(pipeInstalled())
    assert.match(readFileSync(file, "utf8"), /sync --scheduled/)
    assert.ok(logs.some((l) => /pipe enable brain-sync/.test(l)))

    uninstallPipe((s) => logs.push(s))
    assert.ok(!existsSync(file))
    assert.ok(!pipeInstalled())
  } finally {
    delete process.env.COMPANY_BRAIN_SCREENPIPE_DIR
  }
})
