import { strict as assert } from "node:assert"
import { test } from "node:test"
import { distillHeuristic } from "@brain/core"
import type { State } from "../src/config"
import { enrichWorkflow, fetchScreenpipeWorkflows, groupScreenpipeItems, mapWorkflows, mapWorkflowsDetailed, normalizeScreenpipeItem, readScreenpipe, roleOfActor } from "../src/sources/screenpipe"
import { TEST_ZONES, mockServer } from "./helpers"

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
  const items = raw.map((r) => normalizeScreenpipeItem(r)).filter((x) => x !== null)
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

test("groupScreenpipeItems : messages structurés (ancien format messages[]) utilisés tels quels", () => {
  const items = [
    { type: "parsed", content: { timestamp: at(0), app_name: "Claude", window_name: "Claude", frame_id: 9, messages: [{ role: "user", text: "Q" }, { role: "assistant", text: "R" }] } },
    { type: "parsed", content: { timestamp: at(1), app_name: "Claude", window_name: "Claude", frame_id: 10, messages: [{ role: "user", text: "Q" }, { role: "assistant", text: "R" }, { role: "user", text: "Q2" }] } },
  ].map((r) => normalizeScreenpipeItem(r)).filter((x) => x !== null)
  const [c] = groupScreenpipeItems(items)
  assert.deepEqual(c.messages.map((m) => m.text), ["Q", "R", "Q2"])
})

test("normalizeScreenpipeItem : format « parsed » réel (items + actors) → messages avec les bons rôles, titre, URL", () => {
  const raw = {
    type: "Parsed",
    content: {
      frame_id: 42, timestamp: at(0), app_name: "Google Chrome", window_name: "ChatGPT", browser_url: "https://chatgpt.com/c/abc",
      text: "rendu compact…", parser_id: "conversation/chatgpt-web",
      items: [
        { local_id: "c1", parent_local_id: null, kind: "conversation", title: "Clôture mensuelle", body: null, actor: null, occurred_at: null },
        { local_id: "m1", parent_local_id: "c1", kind: "message", title: null, body: "Comment on fait le rapprochement Qonto ?", actor: "You", occurred_at: at(1) },
        { local_id: "m2", parent_local_id: "c1", kind: "message", title: null, body: "Voici la procédure…", actor: "ChatGPT", occurred_at: at(2) },
        { local_id: "d1", parent_local_id: null, kind: "document", title: "Pièce jointe", body: "ignoré", actor: null, occurred_at: null },
      ],
      actors: [{ item_id: 9, local_id: "m1", actor_id: 3, name: "Jean-Marc Dubois", observed_name: "You", assignment_source: "heuristic" }],
    },
  }
  const it = normalizeScreenpipeItem(raw, { selfNames: ["Jean-Marc Dubois"] })!
  assert.equal(it.window, "Clôture mensuelle")
  assert.equal(it.browserUrl, "https://chatgpt.com/c/abc")
  assert.equal(it.text, "")
  assert.deepEqual(
    it.messages!.map((m) => [m.role, m.text, m.at]),
    [
      ["user", "Comment on fait le rapprochement Qonto ?", at(1)],
      ["assistant", "Voici la procédure…", at(2)],
    ],
  )
  const [c] = groupScreenpipeItems([it])
  assert.equal(c.tool, "chatgpt")
  assert.equal(c.messages.length, 2)
  assert.equal(c.title, "Clôture mensuelle")
})

test("roleOfActor : étiquette du parseur, nom résolu par Screenpipe, nom de l'employé", () => {
  assert.equal(roleOfActor("ChatGPT"), "assistant")
  assert.equal(roleOfActor("gpt-5"), "assistant")
  assert.equal(roleOfActor("You"), "user")
  assert.equal(roleOfActor("Vous"), "user")
  assert.equal(roleOfActor("Jean-Marc", "Jean-Marc Dubois", ["Jean-Marc Dubois"]), "user")
  assert.equal(roleOfActor("", "Claude"), "assistant")
  // Dans un outil IA, tout ce qui n'est pas l'assistant vient de l'employé.
  assert.equal(roleOfActor("Sarah"), "user")
})

test("browser_url : un onglet ChatGPT au titre quelconque est lu, un onglet YouTube intitulé « Claude » non", () => {
  const items = [
    { type: "OCR", content: { frame_id: 1, timestamp: at(0), app_name: "Google Chrome", window_name: "Nouvel onglet", browser_url: "https://chatgpt.com/c/1", text: "Question sur la TVA\nRéponse" } },
    { type: "OCR", content: { frame_id: 2, timestamp: at(1), app_name: "Google Chrome", window_name: "Claude", browser_url: "https://www.youtube.com/watch?v=1", text: "vidéo" } },
  ]
    .map((r) => normalizeScreenpipeItem(r))
    .filter((x) => x !== null)
  const convs = groupScreenpipeItems(items)
  assert.equal(convs.length, 1)
  assert.equal(convs[0].tool, "chatgpt")
  assert.equal(convs[0].screenpipe_ref, "1")
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
    const types = srv.requests.filter((q) => q.url.startsWith("/search")).map((q) => new URL(q.url, "http://x").searchParams.get("content_type"))
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

type Row = ReturnType<typeof frame>

/** Faux Screenpipe : /search filtre par fenêtre de temps, renvoie du plus récent au plus ancien (comme le vrai), paginé. */
async function fakeScreenpipe(rows: Row[], opts: { withTotal?: boolean; token?: string; status?: number } = {}) {
  return mockServer((req) => {
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return { status: 401, body: { error: "unauthorized" } }
    if (opts.status) return { status: opts.status, body: { error: "boom" } }
    const u = new URL(req.url, "http://x")
    if (u.pathname !== "/search") return undefined
    const type = u.searchParams.get("content_type")
    const a = Date.parse(u.searchParams.get("start_time")!)
    const b = Date.parse(u.searchParams.get("end_time")!)
    const limit = Number(u.searchParams.get("limit"))
    const offset = Number(u.searchParams.get("offset"))
    const all = type === "ocr" ? rows.filter((r) => Date.parse(r.content.timestamp) >= a && Date.parse(r.content.timestamp) <= b) : []
    all.sort((x, y) => y.content.timestamp.localeCompare(x.content.timestamp))
    const data = all.slice(offset, offset + limit)
    return { body: opts.withTotal === false ? data : { data, pagination: { limit, offset, total: all.length } } }
  })
}

const capturesIn = (r: { conversations: { messages: { text: string }[] }[] }) =>
  r.conversations.flatMap((c) => c.messages.flatMap((m) => [...m.text.matchAll(/capture (\d+) :/g)].map((x) => Number(x[1]))))

for (const withTotal of [true, false]) {
  test(`readScreenpipe : beaucoup de captures → lues en plusieurs passages, aucune perdue (${withTotal ? "avec" : "sans"} total)`, async () => {
    const rows = Array.from({ length: 1500 }, (_, i) =>
      frame(i, i / 15, "Terminal", "claude — projet", `capture ${i} : on avance sur le module de facturation, étape ${i} du chantier`),
    )
    const srv = await fakeScreenpipe(rows, { withTotal })
    try {
      const state: State = {}
      const until = new Date(base + 101 * 60_000)
      const seen = new Set<number>()
      let truncatedOnce = false
      let runs = 0
      for (; runs < 20; runs++) {
        const r = await readScreenpipe({ url: srv.url, state, since: new Date(base - 60_000), until, maxPages: 10 })
        assert.equal(r.available, true)
        if (r.warnings.some((w) => /la suite sera lue/.test(w))) truncatedOnce = true
        for (const n of capturesIn(r)) seen.add(n)
        for (const c of r.commits) c.apply(state)
        if (r.conversations.length === 0 && !r.warnings.length) break
      }
      assert.ok(truncatedOnce, "le premier passage doit être partiel")
      assert.ok(runs < 10, `trop de passages : ${runs}`)
      const missing = rows.map((_, i) => i).filter((i) => !seen.has(i))
      assert.deepEqual(missing, [], `captures perdues : ${missing.length}`)
    } finally {
      await srv.close()
    }
  })
}

test("groupScreenpipeItems : une très longue session est coupée en plusieurs conversations, sans perdre de ligne", () => {
  const items = Array.from({ length: 300 }, (_, i) => normalizeScreenpipeItem(frame(i, i / 30, "Terminal", "claude", `capture ${i} : ${"x".repeat(200)}`))!)
  const convs = groupScreenpipeItems(items, { maxChars: 10_000 })
  assert.ok(convs.length >= 6)
  assert.equal(new Set(convs.map((c) => c.id)).size, convs.length)
  assert.deepEqual(new Set(capturesIn({ conversations: convs })).size, 300)
})

test("readScreenpipe : jeton Screenpipe manquant (401) ou panne (500) → source indisponible, aucun checkpoint", async () => {
  const rows = [frame(1, 0, "Terminal", "claude", "ligne A")]
  for (const [opts, re] of [
    [{ token: "secret" }, /HTTP 401.*--screenpipe-token/],
    [{ status: 500 }, /HTTP 500/],
  ] as const) {
    const srv = await fakeScreenpipe(rows, opts)
    try {
      const state: State = { screenpipe: { last_timestamp: at(-60) } }
      const r = await readScreenpipe({ url: srv.url, state, since: new Date(base - 3600_000), until: new Date(base + 3600_000) })
      assert.equal(r.available, false)
      assert.match(r.warnings.join(" "), re)
      assert.match(r.warnings.join(" "), /relues à la prochaine synchro/)
      assert.equal(r.commits.length, 0)
    } finally {
      await srv.close()
    }
  }
  // Avec le bon jeton, la même période est bien lue.
  const srv = await fakeScreenpipe(rows, { token: "secret" })
  try {
    const r = await readScreenpipe({ url: srv.url, token: "secret", state: { screenpipe: { last_timestamp: at(-60) } }, since: new Date(base - 3600_000), until: new Date(base + 3600_000) })
    assert.equal(r.available, true)
    assert.equal(r.conversations.length, 1)
  } finally {
    await srv.close()
  }
})

test("readScreenpipe : une fenêtre restée ouverte n'est pas renvoyée à chaque synchro (seules les nouvelles lignes partent)", async () => {
  const chat = "On a décidé de passer la clôture mensuelle sur Pennylane.\n1. Exporter les relevés\n2. Importer dans Pennylane\n3. Lettrer les écritures"
  const rows = [
    frame(1, 0, "Claude", "Claude", chat),
    frame(2, 1, "Claude", "Claude", chat),
    frame(3, 15, "Claude", "Claude", chat),
    frame(4, 16, "Claude", "Claude", `${chat}\nOn garde Qonto pour la trésorerie.`),
    frame(5, 31, "Claude", "Claude", chat),
  ]
  const srv = await fakeScreenpipe(rows)
  try {
    const state: State = {}
    const run = async (untilMin: number) => {
      const r = await readScreenpipe({ url: srv.url, state, since: new Date(base - 60_000), until: new Date(base + untilMin * 60_000) })
      for (const c of r.commits) c.apply(state)
      return r
    }
    const r1 = await run(5)
    assert.equal(r1.conversations.length, 1)
    const items1 = distillHeuristic(r1.conversations[0], TEST_ZONES)
    assert.ok(items1.some((i) => i.kind === "decision") && items1.some((i) => i.kind === "procedure"))
    const r2 = await run(20)
    assert.equal(r2.conversations.length, 1)
    assert.equal(r2.conversations[0].messages[1].text, "On garde Qonto pour la trésorerie.")
    const items2 = distillHeuristic(r2.conversations[0], TEST_ZONES)
    assert.ok(!items2.some((i) => /Pennylane/.test(i.title)), JSON.stringify(items2.map((i) => i.title)))
    const r3 = await run(40)
    assert.equal(r3.conversations.length, 0)
  } finally {
    await srv.close()
  }
})

test("mapWorkflows : workflows perso ou hors liste blanche écartés, texte masqué", () => {
  const raw = {
    workflows: [
      { title: "Vérifie le solde Boursorama puis répond sur WhatsApp à Julie (06 12 34 56 78)", description: "Ouvre WhatsApp, écrit à julie.martin@gmail.com, puis Doctolib RDV psychiatre", occurrences: 9, days: 5 },
      { title: "Relance des factures clients", description: "Dans Mail puis Excel", apps: ["Mail", "Microsoft Excel"], occurrences: 6, days: 4 },
      { title: "Prompt quotidien de clôture compta", description: "Demande à Claude le point TVA et écrit à compta@fournil.fr", app_name: "Claude", occurrences: 8, days: 6 },
    ],
  }
  const { workflows, dropped } = mapWorkflowsDetailed(raw, [{ id: "compta", name: "Compta", keywords: ["tva", "compta"] }])
  assert.equal(dropped, 2)
  assert.equal(workflows.length, 1)
  assert.equal(workflows[0].title, "Prompt quotidien de clôture compta")
  assert.ok(!workflows[0].description.includes("compta@fournil.fr"), workflows[0].description)
  assert.equal(workflows[0].zone, "compta")
  // La liste blanche configurée s'applique aussi aux apps des workflows.
  assert.equal(mapWorkflows(raw, [], { whitelist: ["claude", "mail", "excel"] }).length, 2)
})

test("readScreenpipe : en-têtes d'attribution, jeton, filter_pii et limit plafonné à 20", async () => {
  const srv = await mockServer((req) => {
    const u = new URL(req.url, "http://x")
    if (u.pathname === "/search") return { body: { data: [frame(1, 0, "Terminal", "claude", "ligne")], pagination: { total: 1 } } }
    return undefined
  })
  try {
    const r = await readScreenpipe({ url: srv.url, token: "sp_secret", state: {}, since: new Date(base - 60_000), pageSize: 100, meetings: false })
    assert.equal(r.available, true)
    const q = srv.requests.find((x) => x.url.startsWith("/search"))!
    assert.equal(q.headers.authorization, "Bearer sp_secret")
    assert.equal(q.headers["x-screenpipe-client"], "api")
    assert.equal(q.headers["x-screenpipe-agent"], "company-brain")
    const p = new URL(q.url, "http://x").searchParams
    assert.equal(p.get("filter_pii"), "true")
    assert.equal(p.get("limit"), "20")
    assert.ok(!srv.requests.some((x) => x.url.startsWith("/meetings")))
  } finally {
    await srv.close()
  }
})

test("readScreenpipe : réunions terminées → conversations « meeting », checkpoint sur la fin, réunion en cours ignorée", async () => {
  const meetings = [
    { id: 7, meeting_start: at(-60), meeting_end: at(-30), meeting_app: "Zoom", title: "Point compta", attendees: "Claire Martin, Jean-Marc Dubois", note: "Décision : reporter la clôture au 25.", detection_source: "audio" },
    { id: 8, meeting_start: at(-10), meeting_end: null, meeting_app: "Google Meet", title: "En cours", attendees: null, note: null, detection_source: "calendar" },
  ]
  const segments = [
    { id: 1, meetingId: 7, speakerName: "Claire Martin", transcript: "On reporte la clôture au 25.", capturedAt: at(-50) },
    { id: 2, meetingId: 7, speakerName: "Jean-Marc Dubois", transcript: "OK, je préviens le cabinet Durand.", capturedAt: at(-49) },
  ]
  const srv = await mockServer((req) => {
    const u = new URL(req.url, "http://x")
    if (u.pathname === "/search") return { body: { data: [], pagination: { total: 0 } } }
    if (u.pathname === "/meetings") return { body: meetings }
    if (u.pathname === "/meetings/7/transcript") return { body: segments }
    return undefined
  })
  try {
    const state: State = {}
    const r = await readScreenpipe({ url: srv.url, state, since: new Date(base - 2 * 3600_000), until: new Date(base) })
    assert.equal(r.stats.meetings, 1)
    const conv = r.conversations.find((c) => c.tool === "meeting")!
    assert.equal(conv.id, "screenpipe-meeting:7")
    assert.equal(conv.title, "Point compta")
    assert.equal(conv.app, "Zoom")
    assert.match(conv.messages[0].text, /participants : Claire Martin, Jean-Marc Dubois/)
    assert.match(conv.messages[0].text, /Claire Martin : On reporte la clôture au 25\./)
    assert.match(conv.messages[0].text, /Jean-Marc Dubois : OK, je préviens le cabinet Durand\./)
    assert.match(conv.messages[1].text, /reporter la clôture au 25/)
    assert.ok(!r.conversations.some((c) => c.id === "screenpipe-meeting:8"))
    for (const c of r.commits) c.apply(state)
    assert.equal(state.screenpipe?.meetings_last_end, at(-30))
    // Deuxième passage : rien de nouveau, aucune transcription relue.
    const before = srv.requests.length
    const r2 = await readScreenpipe({ url: srv.url, state, since: new Date(base - 2 * 3600_000), until: new Date(base) })
    assert.equal(r2.stats.meetings, 0)
    assert.ok(!r2.conversations.some((c) => c.tool === "meeting"))
    assert.ok(!srv.requests.slice(before).some((q) => q.url.includes("/transcript")))
  } finally {
    await srv.close()
  }
})

test("readScreenpipe : Screenpipe sans /meetings (404) → source réunions simplement absente, sans avertissement", async () => {
  const srv = await mockServer((req) => {
    const u = new URL(req.url, "http://x")
    if (u.pathname === "/search") return { body: { data: [frame(1, 0, "Terminal", "claude", "ligne")], pagination: { total: 1 } } }
    return undefined
  })
  try {
    const r = await readScreenpipe({ url: srv.url, state: {}, since: new Date(base - 60_000) })
    assert.equal(r.available, true)
    assert.equal(r.stats.meetings, undefined)
    assert.deepEqual(r.warnings, [])
  } finally {
    await srv.close()
  }
})

test("workflows Screenpipe : le détail (timingRuns) donne occurrences, jours, heure habituelle et minutes par semaine", async () => {
  const day = (d: number, h: number, m: number) => new Date(Date.UTC(2026, 9, d, h, m)).toISOString()
  const runs = [1, 2, 3, 6, 7].map((d) => ({
    start: { timestamp: day(d, 7, 5), app: "Pennylane", quote: "Rapprochement du jour" },
    end: { timestamp: day(d, 7, 25), app: "Pennylane", quote: "Export terminé" },
    summary: "Rapprochement quotidien",
  }))
  const list = { data: [{ id: "wf-1", title: "Rapprochement compta Qonto / Pennylane", description: "", trigger: "chaque matin", outcome: "écarts listés", evidenceStatus: "supported-steps", catalogStatus: "saved", stageCount: 4 }], pagination: { total: 1, offset: 0, limit: 20 } }
  const srv = await mockServer((req) => {
    const u = new URL(req.url, "http://x")
    if (u.pathname === "/workflows") return { body: list }
    if (u.pathname === "/workflows/wf-1") return { body: { id: "wf-1", title: "Rapprochement compta Qonto / Pennylane", timingRuns: runs } }
    return undefined
  })
  try {
    const { workflows } = await fetchScreenpipeWorkflows(srv.url, undefined, TEST_ZONES)
    assert.equal(workflows.length, 1)
    const w = workflows[0]
    assert.equal(w.occurrences, 5)
    assert.equal(w.days, 5)
    assert.equal(w.zone, "compta")
    assert.match(w.description, /Déclencheur : chaque matin\. Résultat : écarts listés/)
    const h = new Date(day(1, 7, 5))
    assert.equal(w.schedule, `${String(h.getHours()).padStart(2, "0")}h${String(h.getMinutes()).padStart(2, "0")}`)
    // 20 min par occurrence × 5 occurrences sur moins d'une semaine.
    assert.equal(w.minutes_saved_per_week, 100)
    assert.ok(srv.requests.some((q) => q.url.startsWith("/workflows/wf-1?include_automation=false")))
  } finally {
    await srv.close()
  }
})

test("enrichWorkflow : sans timingRuns, le workflow est rendu tel quel", () => {
  const w = { id: "x", title: "T", description: "", occurrences: 0, days: 0, minutes_saved_per_week: 0 }
  assert.deepEqual(enrichWorkflow(w, { stages: [] }), w)
  assert.deepEqual(enrichWorkflow(w, null), w)
})
