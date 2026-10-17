import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { test } from "node:test"
import { EXIT_JOIN_PENDING, EXIT_JOIN_REJECTED, cmdJoin, joinStatePath } from "../src/join"
import { tempDir } from "./helpers"

/** Faux cerveau : /api/join enregistre la demande, /api/join/status rend l'état choisi par le test. */
function fakeBrain() {
  const brain = { status: "pending", requests: [] as { path: string; body: any }[], hash: "" }
  const f = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    const body = JSON.parse(String(init.body))
    brain.requests.push({ path, body })
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status })
    if (path === "/api/join") {
      brain.hash = body.token_hash
      return reply(201, { id: "req-1", status: "pending", org: "Atelier Lumen" })
    }
    if (path === "/api/join/status") {
      const ok = body.id === "req-1" && createHash("sha256").update(body.token).digest("hex") === brain.hash
      return ok ? reply(200, { status: brain.status, org: "Atelier Lumen" }) : reply(404, { error: "Demande introuvable." })
    }
    return reply(404, {})
  }) as unknown as typeof fetch
  return { brain, fetch: f }
}

const quiet = () => {}

test("join : la demande part sans le jeton (empreinte seule), préremplie, puis attend ; code 5 et état gardé", async () => {
  process.env.COMPANY_BRAIN_HOME = tempDir()
  const { brain, fetch } = fakeBrain()
  const code = await cmdJoin({ url: "http://brain.test/", join: "cj_abc", name: "Léa Bernard", title: "Designer", "wait-accept": "0" }, quiet, { fetch })
  assert.equal(code, EXIT_JOIN_PENDING)
  const sent = brain.requests[0].body
  assert.equal(sent.code, "cj_abc")
  assert.equal(sent.name, "Léa Bernard")
  assert.equal(sent.title, "Designer")
  assert.equal(sent.email, undefined, "un champ inconnu n'est pas inventé")
  assert.match(sent.token_hash, /^[0-9a-f]{64}$/)
  assert.ok(!JSON.stringify(sent).includes("cb_"), "le jeton ne part pas avec la demande")
  const state = JSON.parse(readFileSync(joinStatePath(), "utf8"))
  assert.match(state.token, /^cb_/)
  assert.equal(statSync(joinStatePath()).mode & 0o077, 0, "état lisible du seul propriétaire")
})

test("join : relancé sans paramètres, reprend la même demande ; acceptée, enchaîne sur setup avec le jeton", async () => {
  process.env.COMPANY_BRAIN_HOME = tempDir()
  const { brain, fetch } = fakeBrain()
  await cmdJoin({ url: "http://brain.test", join: "cj_abc", "wait-accept": "0" }, quiet, { fetch })
  const token = JSON.parse(readFileSync(joinStatePath(), "utf8")).token
  brain.status = "accepted"
  let setupFlags: Record<string, string | boolean> | null = null
  const code = await cmdJoin({ "no-open": true }, quiet, {
    fetch,
    setup: async (flags) => {
      setupFlags = flags
      return 0
    },
  })
  assert.equal(code, 0)
  assert.equal(brain.requests.filter((r) => r.path === "/api/join").length, 1, "une seule demande")
  assert.deepEqual(setupFlags, { "no-open": true, url: "http://brain.test", token })
  assert.ok(!existsSync(joinStatePath()), "état effacé une fois branché")
})

test("join : attend l'acceptation pendant la commande", async () => {
  process.env.COMPANY_BRAIN_HOME = tempDir()
  const { brain, fetch } = fakeBrain()
  let polls = 0
  const code = await cmdJoin({ url: "http://brain.test", join: "cj_abc" }, quiet, {
    fetch,
    pollMs: 0,
    sleep: async () => {
      if (++polls === 3) brain.status = "accepted"
    },
    setup: async () => 0,
  })
  assert.equal(code, 0)
  assert.equal(polls, 3)
})

test("join : refusée, code 6 et rien d'installé", async () => {
  process.env.COMPANY_BRAIN_HOME = tempDir()
  const { brain, fetch } = fakeBrain()
  brain.status = "rejected"
  let setupCalled = false
  const code = await cmdJoin({ url: "http://brain.test", join: "cj_abc" }, quiet, { fetch, setup: async () => ((setupCalled = true), 0) })
  assert.equal(code, EXIT_JOIN_REJECTED)
  assert.ok(!setupCalled && !existsSync(joinStatePath()))
})

test("join : sans demande en cours ni code, explique quoi faire", async () => {
  process.env.COMPANY_BRAIN_HOME = tempDir()
  await assert.rejects(cmdJoin({}, quiet), /Aucune demande en cours/)
})
