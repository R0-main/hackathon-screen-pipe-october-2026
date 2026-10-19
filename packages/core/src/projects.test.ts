import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeProject, projectZone, renderZones } from "./index"

test("normalizeProject: repository URLs, paths and names", () => {
  assert.equal(normalizeProject("https://github.com/R0-main/Encore.git"), "r0-main/encore")
  assert.equal(normalizeProject("git@github.com:r0-main/encore.git"), "r0-main/encore")
  assert.equal(normalizeProject("ssh://git@gitlab.example.com:2222/team/sub/encore"), "sub/encore")
  assert.equal(normalizeProject("R0-main/encore"), "r0-main/encore")
  assert.equal(normalizeProject("~/dev/Encore/"), "encore")
  assert.equal(normalizeProject("/Users/anas/dev/encore"), "encore")
  assert.equal(normalizeProject("C:\\Users\\anas\\encore"), "encore")
  assert.equal(normalizeProject("  Encore "), "encore")
  assert.equal(normalizeProject("  "), "")
})

const zones = [
  { id: "encore", projects: ["encore"] },
  { id: "api", projects: ["https://github.com/acme/api.git"] },
  { id: "clients", projects: ["clients"] },
  { id: "acme", projects: ["acme"] },
  { id: "dev" },
]

test("projectZone: a folder of the path, wherever it sits", () => {
  assert.equal(projectZone({ cwd: "/Users/anas/dev/encore" }, zones), "encore")
  assert.equal(projectZone({ cwd: "/work/Encore/apps/web" }, zones), "encore")
  assert.equal(projectZone({ cwd: "C:\\code\\encore" }, zones), "encore")
  assert.equal(projectZone({ cwd: "/Users/anas/dev/encore-old" }, zones), undefined)
  assert.equal(projectZone({ cwd: "/Users/anas/dev/other" }, zones), undefined)
  assert.equal(projectZone({}, zones), undefined)
})

test("projectZone: the git repository wins over the folder name", () => {
  // Cloned under another name: the remote still says which project it is.
  assert.equal(projectZone({ cwd: "/tmp/checkout", repo: "git@github.com:acme/api.git" }, zones), "api")
  assert.equal(projectZone({ cwd: "/Users/anas/encore", repo: "https://github.com/acme/api" }, zones), "api")
  // The repository's name alone, written as a folder name.
  assert.equal(projectZone({ cwd: "/tmp/x", repo: "https://github.com/someone/encore" }, zones), "encore")
})

test("projectZone: the deepest folder wins", () => {
  assert.equal(projectZone({ cwd: "/Users/anas/clients/acme/site" }, zones), "acme")
  assert.equal(projectZone({ cwd: "/Users/anas/clients/other" }, zones), "clients")
})

test("renderZones: projects shown to the distiller when there are some", () => {
  assert.equal(
    renderZones([
      { id: "encore", name: "Encore", description: "The Encore app.", keywords: [], projects: ["encore", "acme/encore-api"] },
      { id: "dev", name: "Dev", description: "Code.", keywords: [] },
    ]),
    "- encore: Encore — The Encore app. (projects: encore, acme/encore-api)\n- dev: Dev — Code.",
  )
})
