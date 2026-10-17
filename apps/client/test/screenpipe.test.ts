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

test("groupScreenpipeItems: allowlist, grouping by app+window with a 10-min gap, deduplication", () => {
  const raw = [
    frame(1, 0, "Terminal", "claude — fournil", "> How do we deploy?\nWe merge into main."),
    frame(2, 1, "Terminal", "claude — fournil", "> How do we deploy?\nWe merge into main.\nThen we tag the release."),
    frame(3, 2, "WhatsApp", "Mum", "personal message"),
    frame(4, 3, "Google Chrome", "YouTube - music", "video"),
    frame(5, 4, "Google Chrome", "Claude - New conversation", "Question about VAT"),
    frame(6, 30, "Terminal", "claude — fournil", "New session after a break"),
  ]
  const items = raw.map((r) => normalizeScreenpipeItem(r)).filter((x) => x !== null)
  const convs = groupScreenpipeItems(items)
  assert.equal(convs.length, 3)
  const first = convs.find((c) => c.screenpipe_ref === "1")!
  assert.equal(first.tool, "claude-code")
  assert.equal(first.messages[0].role, "user")
  assert.match(first.messages[0].text, /Session captured on screen: Terminal — claude — fournil/)
  assert.equal(first.messages[1].text, "> How do we deploy?\nWe merge into main.\nThen we tag the release.")
  assert.ok(convs.some((c) => c.screenpipe_ref === "5" && c.tool === "claude"))
  assert.ok(convs.some((c) => c.screenpipe_ref === "6"))
  assert.ok(!convs.some((c) => /WhatsApp|YouTube/.test(c.app + (c.title ?? ""))))
})

test("groupScreenpipeItems: structured messages (old messages[] format) used as is", () => {
  const items = [
    { type: "parsed", content: { timestamp: at(0), app_name: "Claude", window_name: "Claude", frame_id: 9, messages: [{ role: "user", text: "Q" }, { role: "assistant", text: "R" }] } },
    { type: "parsed", content: { timestamp: at(1), app_name: "Claude", window_name: "Claude", frame_id: 10, messages: [{ role: "user", text: "Q" }, { role: "assistant", text: "R" }, { role: "user", text: "Q2" }] } },
  ].map((r) => normalizeScreenpipeItem(r)).filter((x) => x !== null)
  const [c] = groupScreenpipeItems(items)
  assert.deepEqual(c.messages.map((m) => m.text), ["Q", "R", "Q2"])
})

test("normalizeScreenpipeItem: real \"parsed\" format (items + actors) → messages with the right roles, title, URL", () => {
  const raw = {
    type: "Parsed",
    content: {
      frame_id: 42, timestamp: at(0), app_name: "Google Chrome", window_name: "ChatGPT", browser_url: "https://chatgpt.com/c/abc",
      text: "compact rendering…", parser_id: "conversation/chatgpt-web",
      items: [
        { local_id: "c1", parent_local_id: null, kind: "conversation", title: "Monthly closing", body: null, actor: null, occurred_at: null },
        { local_id: "m1", parent_local_id: "c1", kind: "message", title: null, body: "How do we do the Qonto reconciliation?", actor: "You", occurred_at: at(1) },
        { local_id: "m2", parent_local_id: "c1", kind: "message", title: null, body: "Here is the procedure…", actor: "ChatGPT", occurred_at: at(2) },
        { local_id: "d1", parent_local_id: null, kind: "document", title: "Attachment", body: "ignored", actor: null, occurred_at: null },
      ],
      actors: [{ item_id: 9, local_id: "m1", actor_id: 3, name: "Jean-Marc Dubois", observed_name: "You", assignment_source: "heuristic" }],
    },
  }
  const it = normalizeScreenpipeItem(raw, { selfNames: ["Jean-Marc Dubois"] })!
  assert.equal(it.window, "Monthly closing")
  assert.equal(it.browserUrl, "https://chatgpt.com/c/abc")
  assert.equal(it.text, "")
  assert.deepEqual(
    it.messages!.map((m) => [m.role, m.text, m.at]),
    [
      ["user", "How do we do the Qonto reconciliation?", at(1)],
      ["assistant", "Here is the procedure…", at(2)],
    ],
  )
  const [c] = groupScreenpipeItems([it])
  assert.equal(c.tool, "chatgpt")
  assert.equal(c.messages.length, 2)
  assert.equal(c.title, "Monthly closing")
})

test("roleOfActor: parser label, name resolved by Screenpipe, employee's name", () => {
  assert.equal(roleOfActor("ChatGPT"), "assistant")
  assert.equal(roleOfActor("gpt-5"), "assistant")
  assert.equal(roleOfActor("You"), "user")
  // Label of a French chat UI captured on screen (intentional French).
  assert.equal(roleOfActor("Vous"), "user")
  assert.equal(roleOfActor("Jean-Marc", "Jean-Marc Dubois", ["Jean-Marc Dubois"]), "user")
  assert.equal(roleOfActor("", "Claude"), "assistant")
  // In an AI tool, everything that is not the assistant comes from the employee.
  assert.equal(roleOfActor("Sarah"), "user")
})

test("browser_url: a ChatGPT tab with any title is read, a YouTube tab titled \"Claude\" is not", () => {
  const items = [
    { type: "OCR", content: { frame_id: 1, timestamp: at(0), app_name: "Google Chrome", window_name: "New tab", browser_url: "https://chatgpt.com/c/1", text: "Question about VAT\nAnswer" } },
    { type: "OCR", content: { frame_id: 2, timestamp: at(1), app_name: "Google Chrome", window_name: "Claude", browser_url: "https://www.youtube.com/watch?v=1", text: "video" } },
  ]
    .map((r) => normalizeScreenpipeItem(r))
    .filter((x) => x !== null)
  const convs = groupScreenpipeItems(items)
  assert.equal(convs.length, 1)
  assert.equal(convs[0].tool, "chatgpt")
  assert.equal(convs[0].screenpipe_ref, "1")
})

test("readScreenpipe: content type fallback, pagination, checkpoint", async () => {
  const pages = [
    [frame(1, 0, "Terminal", "claude", "line A"), frame(2, 1, "Terminal", "claude", "line A\nline B")],
    [frame(3, 2, "Terminal", "claude", "line B\nline C")],
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
    assert.equal(r.conversations[0].messages[1].text, "line A\nline B\nline C")
    const types = srv.requests.filter((q) => q.url.startsWith("/search")).map((q) => new URL(q.url, "http://x").searchParams.get("content_type"))
    assert.deepEqual(types, ["parsed", "accessibility", "ocr", "ocr"])
    for (const c of r.commits) c.apply(state)
    assert.ok(state.screenpipe?.last_timestamp && state.screenpipe.last_timestamp > at(2))
  } finally {
    await srv.close()
  }
})

test("readScreenpipe: Screenpipe stopped → unavailable, without an exception", async () => {
  const r = await readScreenpipe({ url: "http://127.0.0.1:9", state: {}, since: new Date(base), timeoutMs: 1000 })
  assert.equal(r.available, false)
  assert.match(r.warnings[0], /Screenpipe unreachable/)
})

test("mapWorkflows: tolerant field matching", () => {
  const w = mapWorkflows({ workflows: [{ name: "Invoice export", count: 6, unique_days: 4, typical_time: "09:00" }, { foo: 1 }] }, [
    { id: "finance", name: "Finance", keywords: ["invoice", "invoices"] },
  ])
  assert.equal(w.length, 1)
  assert.deepEqual(w[0], { id: "Invoice export", title: "Invoice export", description: "", schedule: "09:00", occurrences: 6, days: 4, zone: "finance", minutes_saved_per_week: 30 })
})

type Row = ReturnType<typeof frame>

/** Fake Screenpipe: /search filters by time window, returns from newest to oldest (like the real one), paginated. */
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
  r.conversations.flatMap((c) => c.messages.flatMap((m) => [...m.text.matchAll(/capture (\d+):/g)].map((x) => Number(x[1]))))

for (const withTotal of [true, false]) {
  test(`readScreenpipe: many captures → read over several passes, none lost (${withTotal ? "with" : "without"} total)`, async () => {
    const rows = Array.from({ length: 1500 }, (_, i) =>
      frame(i, i / 15, "Terminal", "claude — project", `capture ${i}: we are moving forward on the billing module, step ${i} of the project`),
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
        if (r.warnings.some((w) => /the rest will be read/.test(w))) truncatedOnce = true
        for (const n of capturesIn(r)) seen.add(n)
        for (const c of r.commits) c.apply(state)
        if (r.conversations.length === 0 && !r.warnings.length) break
      }
      assert.ok(truncatedOnce, "the first pass must be partial")
      assert.ok(runs < 10, `too many passes: ${runs}`)
      const missing = rows.map((_, i) => i).filter((i) => !seen.has(i))
      assert.deepEqual(missing, [], `captures lost: ${missing.length}`)
    } finally {
      await srv.close()
    }
  })
}

test("groupScreenpipeItems: a very long session is split into several conversations, without losing a line", () => {
  const items = Array.from({ length: 300 }, (_, i) => normalizeScreenpipeItem(frame(i, i / 30, "Terminal", "claude", `capture ${i}: ${"x".repeat(200)}`))!)
  const convs = groupScreenpipeItems(items, { maxChars: 10_000 })
  assert.ok(convs.length >= 6)
  assert.equal(new Set(convs.map((c) => c.id)).size, convs.length)
  assert.deepEqual(new Set(capturesIn({ conversations: convs })).size, 300)
})

test("readScreenpipe: Screenpipe token missing (401) or outage (500) → source unavailable, no checkpoint", async () => {
  const rows = [frame(1, 0, "Terminal", "claude", "line A")]
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
      assert.match(r.warnings.join(" "), /read again on the next sync/)
      assert.equal(r.commits.length, 0)
    } finally {
      await srv.close()
    }
  }
  // With the right token, the same period is read.
  const srv = await fakeScreenpipe(rows, { token: "secret" })
  try {
    const r = await readScreenpipe({ url: srv.url, token: "secret", state: { screenpipe: { last_timestamp: at(-60) } }, since: new Date(base - 3600_000), until: new Date(base + 3600_000) })
    assert.equal(r.available, true)
    assert.equal(r.conversations.length, 1)
  } finally {
    await srv.close()
  }
})

test("readScreenpipe: a window left open is not sent again on every sync (only the new lines go)", async () => {
  const chat = "We decided to move the monthly closing to Pennylane.\n1. Export the statements\n2. Import into Pennylane\n3. Match the entries"
  const rows = [
    frame(1, 0, "Claude", "Claude", chat),
    frame(2, 1, "Claude", "Claude", chat),
    frame(3, 15, "Claude", "Claude", chat),
    frame(4, 16, "Claude", "Claude", `${chat}\nWe keep Qonto for the cash.`),
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
    assert.equal(r2.conversations[0].messages[1].text, "We keep Qonto for the cash.")
    const items2 = distillHeuristic(r2.conversations[0], TEST_ZONES)
    assert.ok(!items2.some((i) => /Pennylane/.test(i.title)), JSON.stringify(items2.map((i) => i.title)))
    const r3 = await run(40)
    assert.equal(r3.conversations.length, 0)
  } finally {
    await srv.close()
  }
})

test("mapWorkflows: personal workflows or outside the allowlist dropped, text redacted", () => {
  const raw = {
    workflows: [
      { title: "Checks the Boursorama balance then replies to Julie on WhatsApp (06 12 34 56 78)", description: "Opens WhatsApp, writes to julie.martin@gmail.com, then a Doctolib appointment with a psychiatrist", occurrences: 9, days: 5 },
      { title: "Customer invoice reminders", description: "In Mail then Excel", apps: ["Mail", "Microsoft Excel"], occurrences: 6, days: 4 },
      { title: "Daily finance closing prompt", description: "Asks Claude for the VAT status and writes to finance@fournil.fr", app_name: "Claude", occurrences: 8, days: 6 },
    ],
  }
  const { workflows, dropped } = mapWorkflowsDetailed(raw, [{ id: "finance", name: "Finance", keywords: ["vat", "finance"] }])
  assert.equal(dropped, 2)
  assert.equal(workflows.length, 1)
  assert.equal(workflows[0].title, "Daily finance closing prompt")
  assert.ok(!workflows[0].description.includes("finance@fournil.fr"), workflows[0].description)
  assert.equal(workflows[0].zone, "finance")
  // The configured allowlist also applies to the apps of the workflows.
  assert.equal(mapWorkflows(raw, [], { whitelist: ["claude", "mail", "excel"] }).length, 2)
})

test("H-browser-url: the tab URL (browser_url) decides for a browser, before the title", () => {
  const tab = (id: number, window: string, url: string | undefined, text: string) => ({
    type: "OCR",
    content: { frame_id: id, text, timestamp: at(id), app_name: "Google Chrome", window_name: window, ...(url ? { browser_url: url } : {}) },
  })
  const items = [
    tab(1, "Cash 2026", "https://claude.ai/chat/abc", "We decided to keep Qonto for the cash."),
    tab(2, "Claude", "https://mail.google.com/mail/u/0", "Re: dinner on Saturday"),
    tab(3, "Cash 2026", undefined, "Personal spreadsheet"),
  ].map((r) => normalizeScreenpipeItem(r)!)
  assert.equal(items[0].browserUrl, "https://claude.ai/chat/abc")
  assert.equal(items[2].browserUrl, undefined)
  const convs = groupScreenpipeItems(items)
  assert.equal(convs.length, 1, JSON.stringify(convs.map((c) => c.title)))
  assert.match(convs[0].messages[1].text, /keep Qonto/)
  // camelCase format accepted too.
  assert.equal(normalizeScreenpipeItem({ content: { text: "x", timestamp: at(0), app_name: "Arc", browserUrl: "https://chatgpt.com/c/1" } })?.browserUrl, "https://chatgpt.com/c/1")
})

test("readScreenpipe: attribution headers, token, filter_pii and pages of 100 by default", async () => {
  const srv = await mockServer((req) => {
    const u = new URL(req.url, "http://x")
    if (u.pathname === "/search") return { body: { data: [frame(1, 0, "Terminal", "claude", "line")], pagination: { total: 1 } } }
    return undefined
  })
  try {
    const r = await readScreenpipe({ url: srv.url, token: "sp_secret", state: {}, since: new Date(base - 60_000), meetings: false })
    assert.equal(r.available, true)
    const q = srv.requests.find((x) => x.url.startsWith("/search"))!
    assert.equal(q.headers.authorization, "Bearer sp_secret")
    assert.equal(q.headers["x-screenpipe-client"], "api")
    assert.equal(q.headers["x-screenpipe-agent"], "company-brain")
    const p = new URL(q.url, "http://x").searchParams
    assert.equal(p.get("filter_pii"), "true")
    assert.equal(p.get("limit"), "100")
    assert.ok(!srv.requests.some((x) => x.url.startsWith("/meetings")))
  } finally {
    await srv.close()
  }
})

test("readScreenpipe: finished meetings → \"meeting\" conversations, checkpoint on the end, meeting in progress ignored", async () => {
  const meetings = [
    { id: 7, meeting_start: at(-60), meeting_end: at(-30), meeting_app: "Zoom", title: "Finance sync", attendees: "Claire Martin, Jean-Marc Dubois", note: "Decision: move the closing to the 25th.", detection_source: "audio" },
    { id: 8, meeting_start: at(-10), meeting_end: null, meeting_app: "Google Meet", title: "In progress", attendees: null, note: null, detection_source: "calendar" },
  ]
  const segments = [
    { id: 1, meetingId: 7, speakerName: "Claire Martin", transcript: "We move the closing to the 25th.", capturedAt: at(-50) },
    { id: 2, meetingId: 7, speakerName: "Jean-Marc Dubois", transcript: "OK, I will tell the Durand firm.", capturedAt: at(-49) },
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
    assert.equal(conv.title, "Finance sync")
    assert.equal(conv.app, "Zoom")
    assert.match(conv.messages[0].text, /attendees: Claire Martin, Jean-Marc Dubois/)
    assert.match(conv.messages[0].text, /Claire Martin: We move the closing to the 25th\./)
    assert.match(conv.messages[0].text, /Jean-Marc Dubois: OK, I will tell the Durand firm\./)
    assert.match(conv.messages[1].text, /move the closing to the 25th/)
    assert.ok(!r.conversations.some((c) => c.id === "screenpipe-meeting:8"))
    for (const c of r.commits) c.apply(state)
    assert.equal(state.screenpipe?.meetings_last_end, at(-30))
    // Second pass: nothing new, no transcription read again.
    const before = srv.requests.length
    const r2 = await readScreenpipe({ url: srv.url, state, since: new Date(base - 2 * 3600_000), until: new Date(base) })
    assert.equal(r2.stats.meetings, 0)
    assert.ok(!r2.conversations.some((c) => c.tool === "meeting"))
    assert.ok(!srv.requests.slice(before).some((q) => q.url.includes("/transcript")))
  } finally {
    await srv.close()
  }
})

test("readScreenpipe: Screenpipe without /meetings (404) → meetings source simply missing, without a warning", async () => {
  const srv = await mockServer((req) => {
    const u = new URL(req.url, "http://x")
    if (u.pathname === "/search") return { body: { data: [frame(1, 0, "Terminal", "claude", "line")], pagination: { total: 1 } } }
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

test("Screenpipe workflows: the detail (timingRuns) gives occurrences, days, usual time and minutes per week", async () => {
  const day = (d: number, h: number, m: number) => new Date(Date.UTC(2026, 9, d, h, m)).toISOString()
  const runs = [1, 2, 3, 6, 7].map((d) => ({
    start: { timestamp: day(d, 7, 5), app: "Pennylane", quote: "Today's reconciliation" },
    end: { timestamp: day(d, 7, 25), app: "Pennylane", quote: "Export done" },
    summary: "Daily reconciliation",
  }))
  const list = { data: [{ id: "wf-1", title: "Qonto / Pennylane finance reconciliation", description: "", trigger: "every morning", outcome: "discrepancies listed", evidenceStatus: "supported-steps", catalogStatus: "saved", stageCount: 4 }], pagination: { total: 1, offset: 0, limit: 20 } }
  const srv = await mockServer((req) => {
    const u = new URL(req.url, "http://x")
    if (u.pathname === "/workflows") return { body: list }
    if (u.pathname === "/workflows/wf-1") return { body: { id: "wf-1", title: "Qonto / Pennylane finance reconciliation", timingRuns: runs } }
    return undefined
  })
  try {
    const { workflows } = await fetchScreenpipeWorkflows(srv.url, undefined, TEST_ZONES)
    assert.equal(workflows.length, 1)
    const w = workflows[0]
    assert.equal(w.occurrences, 5)
    assert.equal(w.days, 5)
    assert.equal(w.zone, "finance")
    assert.match(w.description, /Trigger: every morning\. Outcome: discrepancies listed/)
    const h = new Date(day(1, 7, 5))
    assert.equal(w.schedule, `${String(h.getHours()).padStart(2, "0")}:${String(h.getMinutes()).padStart(2, "0")}`)
    // 20 min per occurrence × 5 occurrences in less than a week.
    assert.equal(w.minutes_saved_per_week, 100)
    assert.ok(srv.requests.some((q) => q.url.startsWith("/workflows/wf-1?include_automation=false")))
  } finally {
    await srv.close()
  }
})

test("enrichWorkflow: without timingRuns, the workflow is returned as is", () => {
  const w = { id: "x", title: "T", description: "", occurrences: 0, days: 0, minutes_saved_per_week: 0 }
  assert.deepEqual(enrichWorkflow(w, { stages: [] }), w)
  assert.deepEqual(enrichWorkflow(w, null), w)
})
