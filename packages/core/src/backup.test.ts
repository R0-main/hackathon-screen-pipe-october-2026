import { strict as assert } from "node:assert"
import { test } from "node:test"
import { BACKUP_FORMAT, clientsFromCsv, clientsOf, itemKey, matchZone, newBackup, parseBackup, parseCsv, personKey, personSheetMarkdown, toCsv, type PersonSheet } from "./backup"

test("backup: a new backup reads back, a foreign file is refused with a reason", () => {
  const b = newBackup("brain", { name: "Butine", description: "" })
  b.items.push({ zone: "dev", kind: "fact", title: "Deploy on Fridays is forbidden", body: "", entities: [], source: { app: "x", tool: "agent" }, confidence: 0.6 })
  const back = parseBackup(JSON.parse(JSON.stringify(b)))
  assert.ok("backup" in back && back.backup.items.length === 1)
  const foreign = parseBackup({ hello: "world" })
  assert.ok("problems" in foreign && foreign.problems[0].includes("format"))
  const broken = parseBackup({ format: BACKUP_FORMAT, version: 1, kind: "brain", items: [{ zone: "dev", kind: "rumor", title: "x" }] })
  assert.ok("problems" in broken && broken.problems.some((p) => p.startsWith("items.0.kind")))
  assert.ok("problems" in parseBackup({ format: BACKUP_FORMAT, version: 99, kind: "brain" }), "a newer version is refused")
})

test("backup: the same person and the same item across two brains", () => {
  assert.deepEqual(personKey({ name: "  Inès   Laurent ", email: " Ines@Butine.example " }), { email: "ines@butine.example", name: "ines laurent" })
  assert.equal(itemKey({ zone: "dev", title: "Déploiement", body: "Le  vendredi" }), itemKey({ zone: "dev", title: "deploiement", body: "le vendredi" }))
  assert.notEqual(itemKey({ zone: "dev", title: "a", body: "" }), itemKey({ zone: "sales", title: "a", body: "" }))
})

test("csv: quotes, doubled quotes, line breaks in a cell, semicolons and a BOM", () => {
  assert.deepEqual(parseCsv('﻿name,notes\n"Acme, Inc.","said ""yes""\non two lines"\r\nBeta,\n\n'), [
    ["name", "notes"],
    ["Acme, Inc.", 'said "yes"\non two lines'],
    ["Beta", ""],
  ])
  assert.deepEqual(parseCsv("nom;zone\nMiel & Co;Ventes\n"), [
    ["nom", "zone"],
    ["Miel & Co", "Ventes"],
  ])
  const rows = [["name", "notes"], ['A "B"', "x,y"]]
  assert.deepEqual(parseCsv(toCsv(rows)), rows, "an export reads back as is")
})

test("csv: clients with a header, extra columns go to the notes, duplicates and empty names are skipped", () => {
  const { clients, problems } = clientsFromCsv("Company,Zone,Description,City\nRucher du Sud,Sales,Pilot of 40 hives,Nîmes\n,Sales,no name\nrucher du sud,Sales,again\nApiTech,,,\n")
  assert.deepEqual(clients, [
    { name: "Rucher du Sud", zone: "Sales", notes: "Pilot of 40 hives\nCity: Nîmes" },
    { name: "ApiTech", zone: undefined, notes: "" },
  ])
  assert.equal(problems.length, 1)
  const bare = clientsFromCsv("Acme\nBeta\n").clients
  assert.deepEqual(
    bare.map((c) => c.name),
    ["Acme", "Beta"],
    "without a header, the first column is the name",
  )
  assert.equal(matchZone("ventes", [{ id: "sales", name: "Ventes" }]), "sales")
  assert.equal(matchZone("Sales", [{ id: "sales", name: "Ventes" }]), "sales")
  assert.equal(matchZone("hr", [{ id: "sales", name: "Ventes" }]), null)
})

test("clients cited by knowledge: counted per name, accents and case ignored", () => {
  const out = clientsOf([
    { zone: "sales", entities: [{ type: "client", name: "Rucher du Sud" }], created_at: "2026-10-01" },
    { zone: "support", entities: [{ type: "client", name: "rucher du sud" }, { type: "tool", name: "Zendesk" }], created_at: "2026-10-05" },
    { zone: "sales", entities: [{ type: "client", name: "ApiTech" }], created_at: "2026-10-02" },
  ])
  assert.deepEqual(out[0], { name: "Rucher du Sud", count: 2, zones: ["sales", "support"], last_at: "2026-10-05" })
  assert.equal(out.length, 2)
})

test("employee sheet: who did what, by kind, with tasks and the partial notice", () => {
  const sheet: PersonSheet = {
    company: "Butine",
    person: { name: "Hugo Petit", title: "Developer", role: "member", since: "2026-10-01T08:00:00Z" },
    manager: "Claire Martin",
    reports: [],
    zones: [{ name: "Dev", share: 90, items: 2 }],
    readable_zones: ["Dev"],
    totals: { items: 2, decisions: 1, procedures: 1, facts: 0, questions: 0, tasks_open: 1, tasks_done: 0 },
    first_at: "2026-10-02T08:00:00Z",
    last_at: "2026-10-09T08:00:00Z",
    last_sync: null,
    items: [
      { kind: "decision", title: "Postgres over Mongo", body: "Chosen for RLS.", zone: "Dev", created_at: "2026-10-02T08:00:00Z" },
      { kind: "procedure", title: "Deploy Butine", body: "make deploy", zone: "Dev", created_at: "2026-10-09T08:00:00Z" },
    ],
    tasks: [{ title: "Index swarm alerts", zone: "Dev", status: "open", updated_at: "2026-10-09T08:00:00Z" }],
    topics: [{ type: "tool", name: "Postgres", count: 2 }],
    prompts: [],
    skills: [],
    generated_at: "2026-10-17T08:00:00Z",
    partial: true,
  }
  const md = personSheetMarkdown(sheet)
  assert.ok(md.startsWith("# Hugo Petit, Developer\n"))
  assert.ok(md.includes("- Reports to: Claire Martin"))
  assert.ok(md.includes("1 decision, 1 procedure, 0 facts") && md.includes("Most of the work happens in Dev (90%)"))
  assert.ok(md.includes("### Decisions\n\n- **Postgres over Mongo** (Dev, 2026-10-02)\n  Chosen for RLS."))
  assert.ok(md.includes("- [ ] Index swarm alerts (Dev)"))
  assert.ok(md.includes("only covers the zones the reader has access to"))
  assert.ok(!md.includes("## Most frequent prompts"), "an empty section is left out")
})
