import { test } from "node:test"
import assert from "node:assert/strict"
import { calendarEventToItem, calendarWindow, connectorDue, linearIssueToTask, notionBlocksToText, notionKind, notionPageTitle, parseIcs, parseIcsDate, publicConnector, todoistTaskToTask } from "./connectors"

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:abc@google.com",
  "DTSTART:20261020T090000Z",
  "DTEND:20261020T093000Z",
  "SUMMARY:Month-end close check-in",
  "DESCRIPTION:Pennylane export before the 5th\\, then send to the firm\\nAgenda:",
  " review the invoices",
  "LOCATION:Video call",
  "ORGANIZER;CN=Claire Martin:mailto:claire@fournil.example",
  "ATTENDEE;CN=\"Jean-Marc Dubois\";ROLE=REQ-PARTICIPANT:mailto:jm@fournil.example",
  "ATTENDEE:mailto:sarah@fournil.example",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:allday",
  "DTSTART;VALUE=DATE:20261101",
  "SUMMARY:Europain trade show",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:no-date",
  "SUMMARY:Broken",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n")

test("parseIcs: unfolding, escapes, attendees, all-day", () => {
  const events = parseIcs(ICS)
  assert.equal(events.length, 2, "the event without a date is ignored")
  const [a, b] = events
  assert.equal(a.uid, "abc@google.com")
  assert.equal(a.summary, "Month-end close check-in")
  assert.equal(a.description, "Pennylane export before the 5th, then send to the firm\nAgenda:review the invoices")
  assert.equal(a.start, "2026-10-20T09:00:00.000Z")
  assert.equal(a.end, "2026-10-20T09:30:00.000Z")
  assert.equal(a.organizer, "Claire Martin")
  assert.deepEqual(a.attendees, ["Jean-Marc Dubois", "sarah"])
  assert.equal(b.all_day, true)
  assert.equal(b.start, "2026-11-01T00:00:00.000Z")
  assert.equal(parseIcsDate("20261020T0900"), null)
})

test("calendarWindow and calendarEventToItem", () => {
  const now = Date.parse("2026-10-17T12:00:00Z")
  const inWindow = calendarWindow(parseIcs(ICS), now)
  assert.deepEqual(
    inWindow.map((e) => e.uid),
    ["abc@google.com"],
    "the November 1st trade show is more than 14 days away",
  )
  const item = calendarEventToItem(inWindow[0], "finance", now)
  assert.equal(item.kind, "fact")
  assert.equal(item.zone, "finance")
  assert.ok(item.title.startsWith("Upcoming: Month-end close check-in (2026-10-20)"))
  assert.ok(item.body.includes("Attendees: Claire Martin, Jean-Marc Dubois, sarah."))
  assert.ok(item.body.includes("Location: Video call."))
  assert.equal(item.source.tool, "connector")
  assert.equal(item.source.session_id, "calendar:abc@google.com")
  assert.deepEqual(item.entities.map((e) => e.name), ["Claire Martin", "Jean-Marc Dubois", "sarah"])
})

test("notion: blocks → text, title, knowledge kind", () => {
  const blocks = [
    { type: "heading_2", heading_2: { rich_text: [{ plain_text: "Deploy" }] } },
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Merge into " }, { plain_text: "main" }] } },
    { type: "to_do", to_do: { rich_text: [{ plain_text: "Tag" }], checked: true } },
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Watch Sentry" }] } },
    { type: "image", image: {} },
    { type: "paragraph", paragraph: { rich_text: [] } },
  ]
  assert.equal(notionBlocksToText(blocks), "## Deploy\nMerge into main\n[x] Tag\n- Watch Sentry")
  assert.equal(notionPageTitle({ properties: { Name: { type: "title", title: [{ plain_text: "Release procedure" }] } } }), "Release procedure")
  assert.equal(notionPageTitle({ properties: {} }), "Untitled")
  assert.equal(notionKind("Release procedure"), "procedure")
  assert.equal(notionKind("Decision: Stripe Billing"), "decision")
  assert.equal(notionKind("Notes from 10/12"), "fact")
})

test("linear and todoist → external tasks", () => {
  const t = linearIssueToTask({ id: "x1", identifier: "FOU-12", title: "Fix negative stock", url: "https://linear.app/x", state: { type: "started" }, team: { name: "Dev" }, labels: { nodes: [{ name: "bug" }] } })
  assert.equal(t.title, "FOU-12 Fix negative stock")
  assert.equal(t.status, "open")
  assert.ok(t.zone_hint.includes("Dev") && t.zone_hint.includes("bug"))
  assert.equal(linearIssueToTask({ id: "x2", title: "Done", state: { type: "completed" } }).status, "done")
  const td = todoistTaskToTask({ id: "9", content: "File the VAT return", is_completed: false, labels: ["finance"] }, "Finance")
  assert.equal(td.external_source, "todoist")
  assert.equal(td.status, "open")
  assert.ok(td.zone_hint.includes("Finance"))
})

test("publicConnector and connectorDue", () => {
  const pub = publicConnector("notion", { token: "secret_x", enabled: true, zone: "dev" })
  assert.equal(pub.has_token, true)
  assert.equal(pub.configured, true)
  assert.ok(!JSON.stringify(pub).includes("secret_x"), "the token never leaves")
  assert.equal(publicConnector("calendar", { token: "x", enabled: true }).configured, false, "the calendar needs a URL")
  const now = Date.parse("2026-10-17T12:00:00Z")
  assert.equal(connectorDue(undefined, now), false)
  assert.equal(connectorDue({ enabled: true }, now), true)
  assert.equal(connectorDue({ enabled: true, last_run: { at: "2026-10-17T11:30:00Z", ok: true, imported: 0 } }, now), false)
  assert.equal(connectorDue({ enabled: true, last_run: { at: "2026-10-17T10:30:00Z", ok: true, imported: 0 } }, now), true)
})
