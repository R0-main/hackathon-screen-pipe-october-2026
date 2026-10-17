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
  "SUMMARY:Point clôture mensuelle",
  "DESCRIPTION:Export Pennylane avant le 5\\, puis envoi au cabinet\\nOrdre du jour :",
  " relire les factures",
  "LOCATION:Visio",
  "ORGANIZER;CN=Claire Martin:mailto:claire@fournil.example",
  "ATTENDEE;CN=\"Jean-Marc Dubois\";ROLE=REQ-PARTICIPANT:mailto:jm@fournil.example",
  "ATTENDEE:mailto:sarah@fournil.example",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:allday",
  "DTSTART;VALUE=DATE:20261101",
  "SUMMARY:Salon Europain",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:sans-date",
  "SUMMARY:Cassé",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n")

test("parseIcs : dépliage, échappements, participants, journée entière", () => {
  const events = parseIcs(ICS)
  assert.equal(events.length, 2, "l'événement sans date est ignoré")
  const [a, b] = events
  assert.equal(a.uid, "abc@google.com")
  assert.equal(a.summary, "Point clôture mensuelle")
  assert.equal(a.description, "Export Pennylane avant le 5, puis envoi au cabinet\nOrdre du jour :relire les factures")
  assert.equal(a.start, "2026-10-20T09:00:00.000Z")
  assert.equal(a.end, "2026-10-20T09:30:00.000Z")
  assert.equal(a.organizer, "Claire Martin")
  assert.deepEqual(a.attendees, ["Jean-Marc Dubois", "sarah"])
  assert.equal(b.all_day, true)
  assert.equal(b.start, "2026-11-01T00:00:00.000Z")
  assert.equal(parseIcsDate("20261020T0900"), null)
})

test("calendarWindow et calendarEventToItem", () => {
  const now = Date.parse("2026-10-17T12:00:00Z")
  const inWindow = calendarWindow(parseIcs(ICS), now)
  assert.deepEqual(
    inWindow.map((e) => e.uid),
    ["abc@google.com"],
    "le salon du 1er novembre est à plus de 14 jours",
  )
  const item = calendarEventToItem(inWindow[0], "compta", now)
  assert.equal(item.kind, "fact")
  assert.equal(item.zone, "compta")
  assert.ok(item.title.startsWith("À venir : Point clôture mensuelle (2026-10-20)"))
  assert.ok(item.body.includes("Participants : Claire Martin, Jean-Marc Dubois, sarah."))
  assert.ok(item.body.includes("Lieu : Visio."))
  assert.equal(item.source.tool, "connector")
  assert.equal(item.source.session_id, "calendar:abc@google.com")
  assert.deepEqual(item.entities.map((e) => e.name), ["Claire Martin", "Jean-Marc Dubois", "sarah"])
})

test("notion : blocs → texte, titre, type de connaissance", () => {
  const blocks = [
    { type: "heading_2", heading_2: { rich_text: [{ plain_text: "Déployer" }] } },
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Merger sur " }, { plain_text: "main" }] } },
    { type: "to_do", to_do: { rich_text: [{ plain_text: "Tagger" }], checked: true } },
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Surveiller Sentry" }] } },
    { type: "image", image: {} },
    { type: "paragraph", paragraph: { rich_text: [] } },
  ]
  assert.equal(notionBlocksToText(blocks), "## Déployer\nMerger sur main\n[x] Tagger\n- Surveiller Sentry")
  assert.equal(notionPageTitle({ properties: { Name: { type: "title", title: [{ plain_text: "Procédure de release" }] } } }), "Procédure de release")
  assert.equal(notionPageTitle({ properties: {} }), "Sans titre")
  assert.equal(notionKind("Procédure de release"), "procedure")
  assert.equal(notionKind("Décision : Stripe Billing"), "decision")
  assert.equal(notionKind("Notes du 12/10"), "fact")
})

test("linear et todoist → tâches externes", () => {
  const t = linearIssueToTask({ id: "x1", identifier: "FOU-12", title: "Corriger les stocks négatifs", url: "https://linear.app/x", state: { type: "started" }, team: { name: "Dev" }, labels: { nodes: [{ name: "bug" }] } })
  assert.equal(t.title, "FOU-12 Corriger les stocks négatifs")
  assert.equal(t.status, "open")
  assert.ok(t.zone_hint.includes("Dev") && t.zone_hint.includes("bug"))
  assert.equal(linearIssueToTask({ id: "x2", title: "Fini", state: { type: "completed" } }).status, "done")
  const td = todoistTaskToTask({ id: "9", content: "Déclarer la TVA", is_completed: false, labels: ["compta"] }, "Compta")
  assert.equal(td.external_source, "todoist")
  assert.equal(td.status, "open")
  assert.ok(td.zone_hint.includes("Compta"))
})

test("publicConnector et connectorDue", () => {
  const pub = publicConnector("notion", { token: "secret_x", enabled: true, zone: "dev" })
  assert.equal(pub.has_token, true)
  assert.equal(pub.configured, true)
  assert.ok(!JSON.stringify(pub).includes("secret_x"), "le jeton ne sort jamais")
  assert.equal(publicConnector("calendar", { token: "x", enabled: true }).configured, false, "le calendrier demande une URL")
  const now = Date.parse("2026-10-17T12:00:00Z")
  assert.equal(connectorDue(undefined, now), false)
  assert.equal(connectorDue({ enabled: true }, now), true)
  assert.equal(connectorDue({ enabled: true, last_run: { at: "2026-10-17T11:30:00Z", ok: true, imported: 0 } }, now), false)
  assert.equal(connectorDue({ enabled: true, last_run: { at: "2026-10-17T10:30:00Z", ok: true, imported: 0 } }, now), true)
})
