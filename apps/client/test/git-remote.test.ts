import { strict as assert } from "node:assert"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { gitRemote, remoteReader } from "../src/git-remote"
import { tempDir } from "./helpers"

const CONFIG = `[core]
\trepositoryformatversion = 0
[remote "upstream"]
\turl = https://github.com/upstream/encore.git
\tfetch = +refs/heads/*:refs/remotes/upstream/*
[remote "origin"]
\turl = git@github.com:anas/encore.git
[branch "master"]
\tremote = origin
`

test("gitRemote: origin of the repository, from any subfolder", () => {
  const repo = tempDir()
  mkdirSync(join(repo, ".git"))
  writeFileSync(join(repo, ".git", "config"), CONFIG)
  mkdirSync(join(repo, "apps", "web"), { recursive: true })
  assert.equal(gitRemote(repo), "git@github.com:anas/encore.git")
  assert.equal(gitRemote(join(repo, "apps", "web")), "git@github.com:anas/encore.git")
})

test("gitRemote: first remote without origin, nothing outside a repository", () => {
  const repo = tempDir()
  mkdirSync(join(repo, ".git"))
  writeFileSync(join(repo, ".git", "config"), '[remote "fork"]\n\turl = https://gitlab.com/team/api\n')
  assert.equal(gitRemote(repo), "https://gitlab.com/team/api")
  const plain = tempDir()
  mkdirSync(join(plain, ".git"))
  writeFileSync(join(plain, ".git", "config"), "[core]\n\tbare = false\n")
  assert.equal(gitRemote(plain), undefined)
  assert.equal(gitRemote(join(tempDir(), "missing")), undefined)
})

test("gitRemote: worktree (.git file pointing to the main repository)", () => {
  const main = tempDir()
  mkdirSync(join(main, ".git", "worktrees", "feat"), { recursive: true })
  writeFileSync(join(main, ".git", "config"), CONFIG)
  writeFileSync(join(main, ".git", "worktrees", "feat", "commondir"), "../..\n")
  const wt = tempDir()
  writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feat")}\n`)
  assert.equal(gitRemote(wt), "git@github.com:anas/encore.git")
})

test("remoteReader: one read per folder", () => {
  const read = remoteReader()
  assert.equal(read(undefined), undefined)
  const repo = tempDir()
  mkdirSync(join(repo, ".git"))
  writeFileSync(join(repo, ".git", "config"), CONFIG)
  assert.equal(read(repo), "git@github.com:anas/encore.git")
  writeFileSync(join(repo, ".git", "config"), "")
  assert.equal(read(repo), "git@github.com:anas/encore.git")
})
