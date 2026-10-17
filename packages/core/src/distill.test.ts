import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_ZONES,
  MAX_PROMPT_VERBATIM,
  chunkConversation,
  clipVerbatim,
  distillHeuristic,
  extractEntities,
  renderConversation,
  verbatimWindows,
  type Conversation,
  type ConversationMessage,
} from "./index"

const conv = (messages: ConversationMessage[], extra: Partial<Conversation> = {}): Conversation => ({
  id: "s",
  tool: "claude-code",
  app: "Terminal",
  started_at: "2026-10-16T08:00:00Z",
  ended_at: "2026-10-16T08:30:00Z",
  messages,
  ...extra,
})

/** Longest common substring (in characters): checks that no long raw text is copied. */
function longestCommon(a: string, b: string): number {
  let best = 0
  const prev = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diag = 0
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0
      if (prev[j] > best) best = prev[j]
      diag = tmp
    }
  }
  return best
}

const tools = (t: string) => extractEntities(t).filter((e) => e.type === "tool").map((e) => e.name)
const wrongTools = (cases: [string, string[]][]) =>
  cases.map(([t, want]) => [t, tools(t), want] as const).filter(([, got, want]) => JSON.stringify(got) !== JSON.stringify(want))

test("heuristic: no raw ask and no long copied sentences, short re-redacted excerpts", () => {
  const prompt =
    "I need to move Fournil's billing to Stripe Billing before the end of the month. The annual subscriptions of the partner bakeries " +
    "must keep their current price until renewal, and the monthly ones switch right away. The customer " +
    "Maison Kayser has a specific contract with a 15% discount we must keep, and we need to tell finance about the change."
  const answer =
    "We're going with Stripe Billing with separate annual prices for each partner bakery, because native proration avoids recomputing by hand the discounts negotiated case by case. " +
    "Maison Kayser's discount stays a permanent coupon. The test key is sk_test_abcdefghij1234567890 in the .env.\n" +
    "1. Create the annual prices\n2. Migrate the active customers\n3. Turn on the customer portal\nTODO: tell finance about the billing change"
  const items = distillHeuristic(conv([{ role: "user", text: prompt }, { role: "assistant", text: answer }], { cwd: "/home/hugo/fournil" }), DEFAULT_ZONES)
  assert.ok(items.length >= 3, JSON.stringify(items, null, 1))
  for (const i of items) {
    assert.ok(i.title.length <= 140, i.title)
    assert.ok(i.body.length <= 400, `${i.kind}: ${i.body.length} characters`)
    assert.ok(longestCommon(prompt, `${i.title}\n${i.body}`) <= MAX_PROMPT_VERBATIM, `${i.kind} copies the ask: ${i.body}`)
    assert.ok(longestCommon(answer, i.body) <= 200, `${i.kind} copies the answer: ${i.body}`)
    assert.ok(!`${i.title} ${i.body}`.includes("sk_test_"), "excerpts are re-redacted")
  }
  const fact = items.find((i) => i.kind === "fact")
  assert.ok(fact && /^Outcome \(claude-code, project fournil\): /.test(fact.body), fact?.body)
  const procedure = items.find((i) => i.kind === "procedure")
  assert.ok(procedure && procedure.body.split("\n").length <= 8)
})

test("heuristic: nothing for a personal session, and personal sentences of a work session are ignored", () => {
  const personal = conv([
    { role: "user", text: "Help me write an email to my doctor: I've been on sick leave for burnout since Monday." },
    { role: "assistant", text: "Here is a draft email to your doctor about your sick leave. We'll keep a sober tone." },
  ])
  assert.deepEqual(distillHeuristic(personal, DEFAULT_ZONES), [])
  // A personal topic slipped into a work session must never come out in an item.
  const mixed = conv([
    { role: "user", text: "Fix the Stripe webhook bug in production." },
    {
      role: "assistant",
      text: "We decided to keep the signature check on the webhook endpoint.\nWe decided to keep the Netflix night for tonight too.\nTODO: add a test on the webhook",
    },
  ])
  const items = distillHeuristic(mixed, DEFAULT_ZONES)
  assert.ok(items.some((i) => i.kind === "decision"))
  assert.ok(items.every((i) => !/netflix/i.test(`${i.title} ${i.body}`)), JSON.stringify(items, null, 1))
})

test("heuristic: the conversation's zone is the context, a tie never switches to Dev", () => {
  const finance = conv([
    { role: "user", text: "Prepare the September VAT return from Pennylane and the Qonto statements" },
    {
      role: "assistant",
      text:
        "September's collected VAT is €18,240, the VAT return is ready in Pennylane.\n" +
        "We decided to send reminders by email at D+15.\n" +
        "TODO: fix the error on the Boulangerie Martin invoice\n" +
        "TODO: chase Maison Kayser for this month's 2 transfers\n" +
        "TODO: fix the bug in the Pennylane export API endpoint in production",
    },
  ])
  const items = distillHeuristic(finance, DEFAULT_ZONES)
  const zoneOf = (needle: string) => items.find((i) => i.title.includes(needle))?.zone
  assert.equal(zoneOf("Boulangerie Martin"), "finance", "dev 1 / finance 1: tie → the conversation's zone")
  assert.equal(zoneOf("Maison Kayser"), "finance")
  assert.equal(zoneOf("send reminders by email"), "finance")
  assert.equal(zoneOf("export API endpoint"), "dev", "a clear cue (bug, endpoint, api, production) moves the item")
  assert.ok(items.filter((i) => i.kind === "fact").every((i) => i.zone === "finance"))
})

test("decisions: neither a computed label nor a decision still to be made", () => {
  const payroll = conv([
    { role: "user", text: "Compute the tax withholding on Léo's October salary." },
    {
      role: "assistant",
      text:
        "The withholding rate set by the tax office is 7.5%. The withholding therefore comes to €187. " +
        "We'll need a decision from Claire on the bonus before payroll. Chosen option: pay it in two installments.",
    },
  ])
  const items = distillHeuristic(payroll, DEFAULT_ZONES)
  const decisions = items.filter((i) => i.kind === "decision")
  assert.deepEqual(decisions.map((i) => i.title), ["Chosen option: pay it in two installments."], JSON.stringify(items, null, 1))
  assert.ok(items.some((i) => i.kind === "question" && i.title.startsWith("We'll need a decision from Claire")))
})

test("chunking: a long agentic session keeps its final decisions and tasks (segments without a user message)", () => {
  const filler = "I read the file src/payments/webhook.ts and checked the endpoint's error handling, the signature is verified correctly. ".repeat(12)
  const longAnswer =
    Array.from({ length: 25 }, (_, i) => `Pass ${i}: ${filler}`).join("\n\n") +
    "\n\nDone. We're going with the 2026-09 version of the Stripe API for all webhooks.\nTODO: update the signing key in production\nTODO: tell support about the change"
  const c = conv([{ role: "user", text: "Migrate the Stripe webhook to the new API and fix the tests" }, { role: "assistant", text: longAnswer }], { id: "long" })
  const chunks = chunkConversation(c)
  assert.ok(chunks.length >= 2)
  assert.equal(chunks.map((ch) => ch.messages.map((m) => m.text).join("")).join("").replace(/\s/g, "").length, (c.messages[0].text + longAnswer).replace(/\s/g, "").length, "nothing is truncated")
  assert.ok(chunks.every((ch) => ch.messages.every((m) => m.text.length <= 24000)))
  assert.equal(chunks[0].ask, undefined, "the first segment already contains the ask")
  assert.ok(chunks.slice(1).every((ch) => ch.ask === "Migrate the Stripe webhook to the new API and fix the tests"))
  assert.match(renderConversation(chunks[1]), /Initial ask \(reminder, outside this segment\): Migrate the Stripe webhook/)
  const items = chunks.flatMap((ch) => distillHeuristic(ch, DEFAULT_ZONES))
  assert.ok(items.some((i) => i.kind === "decision" && i.title.includes("2026-09 version")), JSON.stringify(items.map((i) => i.title)))
  assert.equal(items.filter((i) => i.kind === "task").length, 2)
  // Incremental sync: only the end of the answer, without a new prompt.
  const tail = distillHeuristic(conv([{ role: "assistant", text: longAnswer.slice(-600) }], { id: "inc" }), DEFAULT_ZONES)
  assert.deepEqual(tail.map((i) => i.kind).sort(), ["decision", "task", "task"])
  // A short conversation is not split and keeps its id.
  const short = chunkConversation(conv([{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello" }], { id: "short" }))
  assert.deepEqual(short.map((ch) => [ch.id, ch.ask]), [["short", undefined]])
})

test("tools: common words do not become tools", () => {
  assert.deepEqual(tools("Give me a notion of this month's cash"), [])
  assert.deepEqual(tools("I have no notion of intra-EU VAT"), [])
  assert.deepEqual(tools("make sure the build passes. Make sure it is green"), [])
  assert.deepEqual(tools("Send the recap to Alan before noon"), [])
  assert.deepEqual(tools("We document the procedure in Notion and track the tickets in Linear"), ["Linear", "Notion"])
  assert.deepEqual(tools("The front end moves to vue.js 3 and the back end to Node 22"), ["Vue", "Node"])
  assert.deepEqual(tools("We migrated the postgres database and the stripe webhook"), ["Stripe", "Postgres"])
  assert.deepEqual(tools("Our health insurance moves to Alan on January 1st"), ["Alan"])
  assert.deepEqual(tools("The scenario in Make chases the invoices"), ["Make"])
})

test("tools: a word at the start of a line, a heading or a cell is not a tool", () => {
  const cases: [string, string[]][] = [
    ["# Cash report\n\n## Linear growth\nCash is healthy.", []],
    ["Here is the update\n\nMake sure: 3 unpaid invoices", []],
    ["- Make sure the sales are right\n- Detail per customer", []],
    ["| Notion | Amount |\n|---|---|", []],
    ["Summary\nNotion of gross margin: revenue minus purchases", []],
    ["Plan\nLinear regression on sales", []],
    ["Key points\nSlack of 2 days in the schedule", []],
    ["Make sure the tests pass\nMake it work", []],
    // real mentions
    ["we move from vue 2 to Vue 3", ["Vue"]],
    ["The docs are in Notion and the tickets in Linear", ["Linear", "Notion"]],
    ["Summary\nThe procedure has been in Notion since yesterday", ["Notion"]],
    ["- we post the alert in Slack when the build breaks", ["Slack"]],
  ]
  assert.deepEqual(wrongTools(cases), [])
  // End to end: a finance answer with a "## Linear growth" heading no longer tags its items with the Linear tool.
  const items = distillHeuristic(
    conv([
      { role: "user", text: "Give me the October cash update" },
      { role: "assistant", text: "## Linear growth\nCash is €42,000. We decided to keep a two-month reserve of expenses.\nTODO: chase the unpaid invoices" },
    ]),
    DEFAULT_ZONES,
  )
  assert.ok(items.length > 0 && items.every((i) => !i.entities.some((e) => e.name === "Linear")), JSON.stringify(items.map((i) => i.entities)))
})

test("decisions: computed labels and hypotheses are not decisions", () => {
  const decisions = (answer: string) =>
    distillHeuristic(conv([{ role: "user", text: "October payroll update" }, { role: "assistant", text: answer }]), DEFAULT_ZONES)
      .filter((i) => i.kind === "decision")
      .map((i) => i.title)
  const cases: [string, string[]][] = [
    ["Here is the computation for October:\n- Gross salary: €2,500\n- Rate applied: 7.5%\n- Amount withheld: €187\nThe withholding therefore comes to €187.", []],
    ["If we keep this overtime pace, November's payroll will be higher.", []],
    ["If we choose the neutral rate, the withholding will be 4%.", []],
    ["In case we opt for quarterly payments, we'll have to tell the bank.", []],
    // real decisions
    ["We decided to keep Stripe for online payments, even if we lose proration.", ["We decided to keep Stripe for online payments, even if we lose proration."]],
    ["Chosen option: an external accountant.", ["Chosen option: an external accountant."]],
    ["We're going with option B for the closing.", ["We're going with option B for the closing."]],
    ["Selected vendor: Qonto for transfers.", ["Selected vendor: Qonto for transfers."]],
  ]
  const wrong = cases.map(([a, want]) => [a, decisions(a), want] as const).filter(([, got, want]) => JSON.stringify(got) !== JSON.stringify(want))
  assert.deepEqual(wrong, [])
})

test("heuristic: no passage of more than 80 characters of the ask in a field sent", () => {
  const prompt =
    "The customer Boulangerie Martin disputes invoice F-2026-118 of €1,240: they say the October 3rd delivery was incomplete " +
    "and threaten to move to Maison Kayser unless we make a commercial gesture. We decided to offer them a 15% credit note on this " +
    "invoice and to keep their morning deliveries as a priority. TODO: call the manager of Boulangerie Martin before Friday to apologize for the delay."
  const answer =
    "I suggest answering the customer Boulangerie Martin by acknowledging the October 3rd delivery problem and offering a credit note " +
    "of 15% on invoice F-2026-118, that is €186 to deduct from the next payment. We'll also need to check with the delivery team what " +
    "happened that day. We decided to keep the customer Boulangerie Martin as a priority for the morning rounds.\n" +
    "TODO: send the €186 credit note to the customer Boulangerie Martin before Friday\n1. Create the credit note\n2. Send it\n3. Tell the delivery team"
  // The ask also arrives through the session title and the reminder of a trailing segment.
  const variants = [
    conv([{ role: "user", text: prompt }, { role: "assistant", text: answer }], { cwd: "/Users/hugo/fournil" }),
    conv([{ role: "user", text: prompt }, { role: "assistant", text: answer }], { title: prompt }),
    conv([{ role: "assistant", text: answer }], { ask: prompt }),
  ]
  for (const c of variants) {
    const items = distillHeuristic(c, DEFAULT_ZONES)
    assert.ok(items.some((i) => i.kind === "fact") && items.some((i) => i.kind === "decision") && items.some((i) => i.kind === "task"), JSON.stringify(items.map((i) => i.kind)))
    for (const i of items) {
      for (const [field, text] of [["title", i.title], ["body", i.body]] as const) {
        assert.ok(longestCommon(prompt, text) <= MAX_PROMPT_VERBATIM, `${i.kind}.${field} copies ${longestCommon(prompt, text)} characters of the ask: ${text}`)
        assert.ok(longestCommon(answer, text) <= 200, `${i.kind}.${field} copies ${longestCommon(answer, text)} characters of the answer`)
      }
    }
  }
  // Items stay useful: the employee's decision and task are there, as a short excerpt.
  const items = distillHeuristic(variants[0], DEFAULT_ZONES)
  assert.ok(items.some((i) => i.kind === "decision" && /15% credit note/.test(i.title)), JSON.stringify(items.map((i) => i.title)))
  assert.ok(items.some((i) => i.kind === "task" && /Boulangerie Martin/.test(i.title)))
  assert.ok(new Set(items.map((i) => i.zone)).size === 1, JSON.stringify(items.map((i) => i.zone)))
})

test("heuristic: a health session dictated in the middle of an email is not distilled", () => {
  const items = distillHeuristic(
    conv([
      { role: "user", text: "Write an email to my physio to move Thursday's session: my herniated disc is acting up." },
      { role: "assistant", text: "Here is an email for your physio. We decided to suggest Friday 9am as the new slot." },
    ]),
    DEFAULT_ZONES,
  )
  assert.deepEqual(items, [])
})

test("tools: a bullet or a sentence subject is a tool on a cue; a heading, a dash or an article is not", () => {
  const cases: [string, string[]][] = [
    // real mentions: tool list, verb after the name, enumeration, preposition + article
    ["Recommended tools:\n- Notion for the docs\n- Slack for alerts\n- Linear for tickets", ["Linear", "Notion", "Slack"]],
    ["For the docs:\n- Stripe for payments\n- Notion for the docs", ["Stripe", "Notion"]],
    ["Sentry is deployed in prod", ["Sentry"]],
    ["Notion is our internal wiki.", ["Notion"]],
    ["We use Notion and Slack", ["Notion", "Slack"]],
    ["Post the recap on the Slack of the team", ["Slack"]],
    ["Export the report to Excel", ["Excel"]],
    ["Stack:\n- Vue 3\n- Node 22", ["Vue", "Node"]],
    // headings, dashes, emoji, parentheses, cells, articles: common words
    ["## 📊 Linear growth", []],
    ["1️⃣ Make sure", []],
    ["## 1 – Make it simple", []],
    ["Cash – Linear forecast", []],
    ["Reminder — Notion of break-even point", []],
    ["**📌 Notion of margin**: revenue - purchases", []],
    ["<td>Notion</td>", []],
    ["The notion of gross margin is essential", []],
    ["Planning — Slack of 2 days", []],
    ["- Linear growth\n- Notion of margin", []],
    ["Léo and Alan talked about Alan's health insurance", []],
  ]
  assert.deepEqual(wrongTools(cases), [])
})

test("tools: a \"- Qonto: …\" bullet does not make the list a tool list; \"Make sure\" is a common phrase", () => {
  const cases: [string, string[]][] = [
    ["Cash summary:\n- Linear growth: cash is healthy\n- Qonto: €12,300 available\n- Pennylane: 3 invoices to reconcile", ["Pennylane", "Qonto"]],
    ["Here is the update:\n- Linear trend: revenue up 8%\n- Stripe: €4,200 collected", ["Stripe"]],
    ["Recap:\n- Notion of gross margin: revenue - purchases\n- Pennylane: export ready", ["Pennylane"]],
    ["Plan:\n- Make a call with Léo\n- Zapier for automation", ["Zapier"]],
    ["Ask Alan to check Léo's benefits", []],
    ["Claude approved Martin's invoice", []],
    // real mentions: tools header, every bullet a tool (one of them unambiguous), verb, version, enumeration, complement
    ["Recommended tools:\n- Notion for the docs\n- Slack for alerts\n- Linear for tickets", ["Linear", "Notion", "Slack"]],
    ["- **Stripe**: payments\n- **Notion**: the docs\n- **Slack**: alerts", ["Stripe", "Notion", "Slack"]],
    ["Sentry is deployed in prod", ["Sentry"]],
    ["we move from vue 2 to Vue 3", ["Vue"]],
    ["Post the recap on the Slack of the team", ["Slack"]],
    ["The scenario in Make chases the invoices", ["Make"]],
    ["The module may import Node built-ins", ["Node"]],
  ]
  assert.deepEqual(wrongTools(cases), [])
})

test("heuristic: a multi-line field does not copy more than 80 characters of the source either", () => {
  // The safety net compares with normalized whitespace: steps joined by "\n" are seen as in the source.
  const source = "Here is the procedure:\n1. Open Pennylane and go to Bank.\n2. Select the bakery's Qonto account.\n3. Filter September's transactions."
  const field = "1. Open Pennylane and go to Bank.\n2. Select the bakery's Qonto account.\n3. Filter September's transactions."
  const clipped = clipVerbatim(field, verbatimWindows([source], MAX_PROMPT_VERBATIM), MAX_PROMPT_VERBATIM)
  assert.ok(longestCommon(source.replace(/\s+/g, " "), clipped.replace(/\s+/g, " ")) <= MAX_PROMPT_VERBATIM, clipped)
  assert.ok(clipped.startsWith("1. Open Pennylane and go to Bank.\n2. "), clipped)

  // End to end: Screenpipe capture of an 8-step answer, and a procedure typed by the employee then repeated by the
  // assistant. The procedure keeps its steps, without copying the source block.
  const steps = [
    "1. Open Pennylane and go to Bank.", "2. Select the bakery's Qonto account.", "3. Filter September's transactions.",
    "4. Match each transaction with its invoice.", "5. Create the missing receipts.", "6. Check the balance against the Qonto statement.",
    "7. Mark the month as reconciled.", "8. Send the summary to the accountant.",
  ].join("\n")
  const prompt = "Explain step by step how to do the Qonto bank reconciliation in Pennylane for the September close."
  const base = { started_at: "2026-10-16T09:00:00Z", ended_at: "2026-10-16T09:05:00Z" }
  const variants: [Conversation, string][] = [
    [
      {
        ...base, id: "screenpipe:1", tool: "claude", app: "Google Chrome", title: "Qonto reconciliation - Claude", screenpipe_ref: "1",
        messages: [{ role: "user", text: "Session captured on screen" }, { role: "assistant", text: `New chat\n${prompt}\nHere is the procedure:\n${steps}` }],
      },
      `New chat\n${prompt}\nHere is the procedure:\n${steps}`,
    ],
    [conv([{ role: "user", text: `Here is my closing procedure, rephrase it:\n${steps}` }, { role: "assistant", text: `Here is your procedure:\n${steps}` }]), steps],
  ]
  for (const [c, captured] of variants) {
    const items = distillHeuristic(c, DEFAULT_ZONES)
    const procedure = items.find((i) => i.kind === "procedure")
    assert.ok(procedure && procedure.body.split("\n").length === 8, JSON.stringify(procedure))
    for (const i of items) {
      for (const text of [i.title, i.body]) {
        const n = longestCommon(captured.replace(/\s+/g, " "), text.replace(/\s+/g, " "))
        assert.ok(n <= MAX_PROMPT_VERBATIM, `${c.id} ${i.kind} copies ${n} characters: ${text}`)
      }
    }
  }
})

test("heuristic: screen capture (OCR) — no field copies more than 80 characters of the captured text", () => {
  // Screenpipe: the ask typed by the employee is in the OCR text, hence on the "assistant" side.
  const prompt =
    "The customer Boulangerie Martin disputes invoice F-2026-118 of €1,240 because the October 3rd delivery arrived two " +
    "hours late and they threaten to switch to a competitor. Help me answer them."
  const ocr =
    `New chat\n${prompt}\n` +
    "I suggest answering the customer by acknowledging the October 3rd delivery delay, then offering a clear, quantified commercial gesture to keep them.\n" +
    "We decided to offer a 15% credit note on invoice F-2026-118 to the customer Boulangerie Martin, to deduct from the next payment.\n" +
    "TODO: send the credit note to the customer Boulangerie Martin before Friday and tell the morning delivery team\n" +
    "1. Create the 15% credit note in Pennylane for invoice F-2026-118 of the customer Boulangerie Martin\n2. Send it\n3. Tell the delivery team"
  const base = { started_at: "2026-10-16T09:00:00Z", ended_at: "2026-10-16T09:05:00Z" }
  const variants: Conversation[] = [
    {
      ...base, id: "screenpipe:1", tool: "claude", app: "Google Chrome", title: "Boulangerie Martin invoice dispute - Claude", screenpipe_ref: "1",
      messages: [{ role: "user", text: "Session captured on screen: Google Chrome — Boulangerie Martin invoice dispute - Claude" }, { role: "assistant", text: ocr }],
    },
    // Structured messages from a web assistant (ChatGPT): same rule.
    { ...base, id: "web", tool: "chatgpt", app: "Arc", messages: [{ role: "user", text: prompt }, { role: "assistant", text: ocr }] },
  ]
  for (const c of variants) {
    const items = distillHeuristic(c, DEFAULT_ZONES)
    assert.ok(items.some((i) => i.kind === "decision") && items.some((i) => i.kind === "task"), JSON.stringify(items.map((i) => i.kind)))
    for (const i of items) {
      for (const [field, text] of [["title", i.title], ["body", i.body]] as const) {
        const n = longestCommon(ocr.replace(/\s+/g, " "), text.replace(/\s+/g, " "))
        assert.ok(n <= MAX_PROMPT_VERBATIM, `${c.id} ${i.kind}.${field} copies ${n} characters of the captured text: ${text}`)
      }
    }
  }
  // Claude Code logs keep longer answer excerpts (200 characters): there the assistant does not repeat the ask.
  const cc = distillHeuristic(conv([{ role: "user", text: "Martin dispute update" }, { role: "assistant", text: ocr.split("\n").slice(2).join("\n") }]), DEFAULT_ZONES)
  assert.ok(cc.some((i) => i.kind === "decision" && i.body.length > MAX_PROMPT_VERBATIM + 20), JSON.stringify(cc.map((i) => i.body)))
})

test("tools: a list of only ambiguous names is not a tool list; \"the Notion of Fournil\", \"The Sentry is deployed\"", () => {
  const cases: [string, string[]][] = [
    // every bullet starts with an ambiguous tool name, none with an unambiguous tool: people or words
    ["Team:\n- Claude: manager, approves quotes\n- Alan: accountant, handles benefits", []],
    ["Topology:\n- Node A: 3 connections\n- Node B: 2 connections", []],
    ["I recommend:\n- Notion for the docs\n- Slack for alerts\n- Linear for tickets", []],
    // with an unambiguous tool, the list stays a tool list
    ["I recommend:\n- Stripe for payments\n- Notion for the docs\n- Slack for alerts", ["Stripe", "Notion", "Slack"]],
    // "of" + proper noun: a complement, not a common noun ("Notion of margin")
    ["In the Notion of Fournil, on the Process page, add the procedure", ["Notion"]],
    ["Recap:\n- Notion of gross margin: revenue - purchases\n- Pennylane: export ready", ["Pennylane"]],
    // determiner + tool + verb; "and" + tool + verb
    ["The Sentry is deployed in prod since Monday", ["Sentry"]],
    ["Our Notion is our wiki", ["Notion"]],
    ["This Slack is for alerts", ["Slack"]],
    ["Sentry reports the errors and Slack sends the alerts", ["Slack", "Sentry"]],
    ["Qonto syncs the payments and Notion stores the docs", ["Notion", "Qonto"]],
    // Make and Linear stay ordinary words after a determiner; "Ask Alan to check", "Claude approved" are people
    ["In the table, the Linear trend is clear", []],
    ["Ask Alan to check Léo's benefits", []],
    ["Claude approved Martin's invoice", []],
  ]
  assert.deepEqual(wrongTools(cases), [])
})

/** Best of three measurements (garbage collection can slow down a single one). */
function bestMs(f: () => unknown): number {
  f()
  return Math.min(...[0, 1, 2].map(() => {
    const t0 = performance.now()
    f()
    return performance.now() - t0
  }))
}
const repeatTo = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)

test("tools: linear on a long line of \"Make sure\" / \"Notion of margin\" and a long list of \"- Notion\"", () => {
  const slow: string[] = []
  for (const [unit, n, limit] of [["Make sure ", 1_000_000, 400], ["Notion of margin ", 1_000_000, 400], ["- Notion\n", 320_000, 400], ["- the Notion\n", 320_000, 400]] as const) {
    const ms = bestMs(() => extractEntities(repeatTo(unit, n)))
    if (ms > limit) slow.push(`${JSON.stringify(unit)} × ${n}: ${ms.toFixed(0)} ms`)
  }
  assert.deepEqual(slow, [])
})

test("heuristic: 320 KB distilled in under 400 ms (tasks, screen capture, numbered steps)", () => {
  const unique = (f: (i: number) => string) => {
    let s = ""
    for (let i = 1; s.length < 320_000; i++) s += f(i)
    return s
  }
  const tasks = unique((i) => `- [ ] chase customer number ${i} about the invoice\n`)
  const stepsText = unique((i) => `${i}. Open Pennylane and export journal ${i}\n`)
  const runs: [string, Conversation][] = [
    ["tasks", conv([{ role: "user", text: "Can you help me with the accounting?" }, { role: "assistant", text: tasks }])],
    ["tasks (screen)", conv([{ role: "user", text: "Captured session" }, { role: "assistant", text: tasks }], { id: "screenpipe:1", tool: "chatgpt", app: "Google Chrome" })],
    ["steps (screen)", conv([{ role: "user", text: "Captured session" }, { role: "assistant", text: stepsText }], { id: "screenpipe:2", tool: "chatgpt", app: "Google Chrome" })],
  ]
  const slow: string[] = []
  for (const [name, c] of runs) {
    const ms = bestMs(() => distillHeuristic(c, DEFAULT_ZONES))
    if (ms > 400) slow.push(`${name}: ${ms.toFixed(0)} ms`)
  }
  assert.deepEqual(slow, [])
  // The result is the same as without the early stop: six items at most, the first ones found.
  const items = distillHeuristic(runs[0][1], DEFAULT_ZONES)
  assert.equal(items.length, 6)
  assert.deepEqual(items.map((i) => i.kind), ["fact", "task", "task", "task", "task", "task"])
})

test("verbatimWindows: the hash index answers like a Set of the windows", () => {
  let seed = 11
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
  const alphabet = ["a", "b", " ", "\n", "é", "ab", "  "]
  for (let trial = 0; trial < 60; trial++) {
    const max = [3, 6, 20][trial % 3]
    const texts = Array.from({ length: 1 + rnd(3) }, () => Array.from({ length: rnd(120) }, () => alphabet[rnd(alphabet.length)]).join(""))
    const expected = new Set<string>()
    for (const t of texts) {
      const s = t.replace(/\s+/g, " ").trim()
      for (let i = 0; i + max < s.length; i++) expected.add(s.slice(i, i + max + 1))
    }
    const index = verbatimWindows(texts, max)
    assert.equal(index.size === 0, expected.size === 0)
    for (const w of expected) assert.ok(index.has(w), JSON.stringify(w))
    // Missing windows, including those spanning two texts.
    const joined = texts.map((t) => t.replace(/\s+/g, " ").trim()).join(" ")
    for (let i = 0; i + max < joined.length; i++) {
      const w = joined.slice(i, i + max + 1)
      assert.equal(index.has(w), expected.has(w), JSON.stringify(w))
    }
  }
})

test("procedure: \"Step N/M: \", one step per line, without reusing the format typed by the employee", () => {
  // The employee types "Step N: …", the assistant repeats "N. …". Rewritten as "Step N: …", the steps would copy
  // the ask and the safety net would cut the procedure after 1.5 steps.
  const steps = ["Open Pennylane and go to Bank.", "Select the business Qonto account.", "Filter September's transactions.", "Match each transaction with its invoice.", "Check the balance against the statement."]
  const typed = `Here is my procedure, rephrase it:\n${steps.map((s, i) => `Step ${i + 1}: ${s}`).join("\n")}`
  const echoed = `Here is your procedure:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
  const b = distillHeuristic(conv([{ role: "user", text: typed }, { role: "assistant", text: echoed }]), DEFAULT_ZONES).find((i) => i.kind === "procedure")
  assert.equal(
    b?.body,
    "Step 1/5: Open Pennylane and go to Bank.\nStep 2/5: Select the business Qonto account.\nStep 3/5: Filter September's transactions.\nStep 4/5: Match each transaction with its invoice.\nStep 5/5: Check the balance against the statement.",
  )

  // Long steps typed then repeated. Each step is shortened, and stays on its own line.
  const long = [
    "1. Open Pennylane, go to the Bank menu then select the bakery's Qonto account for the month of September.",
    "2. Filter the unreconciled transactions, then match each one with its corresponding supplier or customer invoice.",
    "3. For each transaction without a receipt, create a document request and email the supplier a reminder that same day.",
    "4. Check that the balance shown in Pennylane matches the month-end Qonto statement exactly, otherwise note the difference.",
  ].join("\n")
  const c = distillHeuristic(conv([{ role: "user", text: `Rephrase my procedure:\n${long}` }, { role: "assistant", text: `Sure:\n${long}` }]), DEFAULT_ZONES).find((i) => i.kind === "procedure")
  const lines = (c?.body ?? "").split("\n")
  assert.equal(lines.length, 4, c?.body)
  lines.forEach((l, i) => assert.ok(l.startsWith(`Step ${i + 1}/4: `) && l.endsWith("…"), l))
  assert.ok(longestCommon(long.replace(/\s+/g, " "), (c?.body ?? "").replace(/\s+/g, " ")) <= MAX_PROMPT_VERBATIM)
  // Directly: a cut spanning the end of a step keeps the line break.
  const field = long.split("\n").map((l, i) => `Step ${i + 1}/4: ${l.replace(/^\d+\. /, "")}`).join("\n")
  assert.equal(clipVerbatim(field, verbatimWindows([long], MAX_PROMPT_VERBATIM), MAX_PROMPT_VERBATIM), c?.body)

  // A step that already names itself is not renumbered (otherwise: "Step 1: Step 1 of the runbook").
  const runbook = "Here:\n1. Step 1 of the runbook: check the logs\n2. Step 2 of the runbook: restart the service\n3. Step 3 of the runbook: tell the team"
  const r = distillHeuristic(conv([{ role: "user", text: "Remind me of the restart runbook" }, { role: "assistant", text: runbook }]), DEFAULT_ZONES).find((i) => i.kind === "procedure")
  assert.equal(r?.body, "Step 1 of the runbook: check the logs\nStep 2 of the runbook: restart the service\nStep 3 of the runbook: tell the team")
})
