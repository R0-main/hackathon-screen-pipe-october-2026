import { strict as assert } from "node:assert"
import { test } from "node:test"
import type { State } from "../src/config"
import { groupScreenpipeItems, mapWorkflows, normalizeScreenpipeItem, readScreenpipe } from "../src/sources/screenpipe"
import { mockServer } from "./helpers"

const base = Date.parse("2026-10-16T09:00:00Z")
const at = (min: number) => new Date(base + min * 60_000).toISOString()

function frame(id: number, min: number, app: string, window: string, text: string) {
  return { type: "OCR", content: { frame_id: id, text, timestamp: at(min), app_name: app, window_name: window } }
}

test("groupScreenpipeItems : liste blanche, regroupement app+fenêtre avec trou de 10 min, dédoublonnage", () => {
  const raw = [
    frame(1, 0, "Terminal", "claude — fournil", "> Comment déployer ?\nOn merge sur main."),
    frame(2, 1, "Terminal", "claude — fournil", "> Comment déployer ?\nOn merge sur main.\nPuis on tague la release."),
    frame(3, 2, "WhatsApp", "Maman", "message perso"),
    frame(4, 3, "Google Chrome", "YouTube - musique", "vidéo"),
    frame(5, 4, "Google Chrome", "Claude - Nouvelle conversation", "Question sur la TVA"),
    frame(6, 30, "Terminal", "claude — fournil", "Nouvelle session après une pause"),
  ]
  const items = raw.map(normalizeScreenpipeItem).filter((x) => x !== null)
  const convs = groupScreenpipeItems(items)
  assert.equal(convs.length, 3)
  const first = convs.find((c) => c.screenpipe_ref === "1")!
  assert.equal(first.tool, "claude-code")
  assert.equal(first.messages[0].role, "user")
  assert.match(first.messages[0].text, /Session capturée à l'écran : Terminal — claude — fournil/)
  assert.equal(first.messages[1].text, "> Comment déployer ?\nOn merge sur main.\nPuis on tague la release.")
  assert.ok(convs.some((c) => c.screenpipe_ref === "5" && c.tool === "claude"))
  assert.ok(convs.some((c) => c.screenpipe_ref === "6"))
  assert.ok(!convs.some((c) => /WhatsApp|YouTube/.test(c.app + (c.title ?? ""))))
})

test("groupScreenpipeItems : messages structurés (parsed) utilisés tels quels", () => {
  const items = [
    { type: "parsed", content: { timestamp: at(0), app_name: "Claude", window_name: "Claude", frame_id: 9, messages: [{ role: "user", text: "Q" }, { role: "assistant", text: "R" }] } },
    { type: "parsed", content: { timestamp: at(1), app_name: "Claude", window_name: "Claude", frame_id: 10, messages: [{ role: "user", text: "Q" }, { role: "assistant", text: "R" }, { role: "user", text: "Q2" }] } },
  ].map(normalizeScreenpipeItem).filter((x) => x !== null)
  const [c] = groupScreenpipeItems(items)
  assert.deepEqual(c.messages.map((m) => m.text), ["Q", "R", "Q2"])
})

test("readScreenpipe : repli de type de contenu, pagination, checkpoint", async () => {
  const pages = [
    [frame(1, 0, "Terminal", "claude", "ligne A"), frame(2, 1, "Terminal", "claude", "ligne A\nligne B")],
    [frame(3, 2, "Terminal", "claude", "ligne B\nligne C")],
  ]
  const srv = await mockServer((req) => {
    const u = new URL(req.url, "http://x")
    if (u.pathname !== "/search") return undefined
    const type = u.searchParams.get("content_type")
    if (type === "parsed") return { status: 400, body: { error: "invalid content type" } }
    if (type === "accessibility") return { body: { data: [], pagination: { limit: 2, offset: 0, total: 0 } } }
    const offset = Number(u.searchParams.get("offset"))
    const page = pages[offset / 2] ?? []
    return { body: { data: page, pagination: { limit: 2, offset, total: 3 } } }
  })
  try {
    const state: State = {}
    const r = await readScreenpipe({ url: srv.url, state, since: new Date(base - 3600_000), pageSize: 2 })
    assert.equal(r.available, true)
    assert.equal(r.stats.content_type, "ocr")
    assert.equal(r.conversations.length, 1)
    assert.equal(r.conversations[0].messages[1].text, "ligne A\nligne B\nligne C")
    const types = srv.requests.map((q) => new URL(q.url, "http://x").searchParams.get("content_type"))
    assert.deepEqual(types, ["parsed", "accessibility", "ocr", "ocr"])
    for (const c of r.commits) c.apply(state)
    assert.ok(state.screenpipe?.last_timestamp && state.screenpipe.last_timestamp > at(2))
  } finally {
    await srv.close()
  }
})

test("readScreenpipe : Screenpipe arrêté → indisponible, sans exception", async () => {
  const r = await readScreenpipe({ url: "http://127.0.0.1:9", state: {}, since: new Date(base), timeoutMs: 1000 })
  assert.equal(r.available, false)
  assert.match(r.warnings[0], /Screenpipe injoignable/)
})

test("mapWorkflows : correspondance tolérante des champs", () => {
  const w = mapWorkflows({ workflows: [{ name: "Export des factures", count: 6, unique_days: 4, typical_time: "09:00" }, { foo: 1 }] }, [
    { id: "compta", name: "Compta", keywords: ["facture", "factures"] },
  ])
  assert.equal(w.length, 1)
  assert.deepEqual(w[0], { id: "Export des factures", title: "Export des factures", description: "", schedule: "09:00", occurrences: 6, days: 4, zone: "compta", minutes_saved_per_week: 30 })
})
