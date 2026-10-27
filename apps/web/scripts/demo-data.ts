// Fictional company for the demo: Encore, refurbished smartphones with a 2-year warranty, for individuals and company fleets.

import type { Entity, KnowledgeKind, Role, SkillFile } from "@brain/core"

export const DEMO_ORG = {
  name: "Encore",
  description:
    "Encore refurbishes smartphones and sells them online with a 2-year warranty, to individuals and to companies that equip their teams. Every phone is tested in its Lyon workshop, where an AI grades the screen from photos before a technician confirms. 2,100 phones sold a month, 40 business customers, 18 people (6 at the office, 12 technicians in the workshop).",
}

/** The demo company's former names: a demo brain still on one of them is replaced once by the current demo. */
export const LEGACY_DEMO_NAMES = ["Fournil", "Butine"]

/**
 * `manager`: key of the person this seat reports to (declared earlier in the list).
 * `publishSkills`: can push skills into the brain (admins always can).
 */
export type DemoUser = {
  key: string
  name: string
  title: string
  role: Role
  zones: string[]
  email: string
  manager?: string
  publishSkills?: boolean
}

export const DEMO_USERS: DemoUser[] = [
  { key: "claire", name: "Claire Martin", title: "CEO", role: "admin", zones: [], email: "claire@encore.example" },
  { key: "hugo", name: "Hugo Bernard", title: "Lead dev", role: "member", zones: ["dev", "product", "support"], email: "hugo@encore.example", manager: "claire", publishSkills: true },
  { key: "ines", name: "Inès Lefèvre", title: "Full-stack developer", role: "member", zones: ["dev", "product"], email: "ines@encore.example", manager: "hugo" },
  { key: "jeanmarc", name: "Jean-Marc Dubois", title: "Finance lead", role: "member", zones: ["finance"], email: "jean-marc@encore.example", manager: "claire", publishSkills: true },
  { key: "sarah", name: "Sarah Cohen", title: "Head of B2B Sales", role: "member", zones: ["sales", "support", "product"], email: "sarah@encore.example", manager: "claire" },
  { key: "leo", name: "Léo Petit", title: "Product manager", role: "member", zones: ["product", "dev", "support", "sales"], email: "leo@encore.example", manager: "claire" },
]

export type DemoItem = {
  author: string
  zone: string
  kind: KnowledgeKind
  title: string
  body: string
  entities: Entity[]
  daysAgo: number
  tool?: "claude-code" | "codex" | "chatgpt" | "claude" | "meeting" | "agent"
  /** App seen by Screenpipe (meeting tool, browser). Defaults by tool. */
  app?: string
  done?: boolean
}

const t = (name: string): Entity => ({ type: "tool", name })
const c = (name: string): Entity => ({ type: "client", name })
const p = (name: string): Entity => ({ type: "person", name })
const pr = (name: string): Entity => ({ type: "project", name })

export const DEMO_ITEMS: DemoItem[] = [
  // --- Dev ---
  {
    author: "hugo", zone: "dev", kind: "decision", daysAgo: 9, tool: "claude-code",
    title: "Screen grading: Claude proposes the grade from the photos, the technician confirms",
    body: "Every phone is photographed on the workshop bench (front, back, both edges). The model proposes Excellent, Very good or Fair with the scratches it sees; the technician confirms in one tap. 3 grades out of 4 are confirmed as is: 40 seconds saved per phone, 1,400 phones a week. Decided with Léo.",
    entities: [t("Claude"), p("Léo Petit"), pr("AI grading")],
  },
  {
    author: "hugo", zone: "dev", kind: "procedure", daysAgo: 8, tool: "claude-code",
    title: "Deploy Encore to production",
    body: "1. Merge into main through an approved PR.\n2. GitHub Actions CI runs the tests and applies the Supabase migrations on staging.\n3. Create the vX.Y.Z tag: Vercel deploys the shop and the API.\n4. Watch Sentry for 15 minutes; roll back by promoting the previous release on Vercel.\nThe workshop app (the tablets on the benches) never ships with this tag: it updates at night, never during workshop hours (8am to 6pm).",
    entities: [t("GitHub"), t("Supabase"), t("Vercel"), t("Sentry")],
  },
  {
    author: "ines", zone: "dev", kind: "fact", daysAgo: 7, tool: "claude-code",
    title: "Under the workshop's neon lights, the model missed one hairline scratch in five",
    body: "On dark screens, the bench's overhead light hides the fine scratches: the grading came out too generous. Fixed with a side light at 30° and a second photo; the grading prompt now receives both (grading/prompt.ts).",
    entities: [pr("AI grading"), pr("Workshop app")],
  },
  {
    author: "hugo", zone: "dev", kind: "decision", daysAgo: 6, tool: "claude-code",
    title: "Selling prices recomputed every night from the market, no longer set by hand",
    body: "The pricing job reads the buyback price paid, competitors' prices and our stock for each model, then proposes the selling price. Outside a ±8% band, Léo validates. 1,400 references could no longer be priced by hand.",
    entities: [pr("Pricing engine"), t("Supabase"), t("Postgres")],
  },
  {
    author: "ines", zone: "dev", kind: "task", daysAgo: 3, tool: "claude-code",
    title: "Measure the battery health of iPhones whose battery was replaced",
    body: "After a battery swap, the diagnostic reads no battery health: the phone goes online without its percentage on the product page. Measure the real capacity with a charge cycle on the bench instead.",
    entities: [pr("Diagnostics"), pr("Workshop app")],
  },
  {
    author: "ines", zone: "dev", kind: "task", daysAgo: 5, tool: "claude-code", done: true,
    title: "Add Playwright e2e tests on the checkout paid in installments with Alma",
    body: "Covers the cart, the choice of 3 or 4 installments, the return from Alma and the order confirmation email.",
    entities: [t("Playwright"), t("Alma")],
  },
  {
    author: "hugo", zone: "dev", kind: "fact", daysAgo: 4, tool: "codex",
    title: "The Stripe charge.refunded webhook can arrive before the return reaches the workshop",
    body: "The handler is made idempotent (key = event.id) and the refund is matched to the return later, when the technician scans the parcel.",
    entities: [t("Stripe"), pr("Returns")],
  },
  {
    author: "hugo", zone: "dev", kind: "procedure", daysAgo: 2, tool: "claude-code",
    title: "Restore a Supabase backup on staging",
    body: "1. Download the daily backup from the Supabase dashboard.\n2. supabase db reset --linked on staging.\n3. Restore with pg_restore --no-owner.\n4. Rerun the missing migrations then check the number of orders and of phones in stock.",
    entities: [t("Supabase"), t("Postgres")],
  },
  {
    author: "ines", zone: "dev", kind: "question", daysAgo: 1, tool: "claude-code",
    title: "Should the grading model also look at the frame's corners?",
    body: "Half of the \"not as described\" returns are about dents on the corners, which the photos do not cover. Two more photos per phone cost 20 seconds per bench but would avoid about 60 returns a month.",
    entities: [pr("AI grading"), pr("Returns")],
  },
  // --- Product ---
  {
    author: "leo", zone: "product", kind: "decision", daysAgo: 9, tool: "claude",
    title: "Priority of the quarter: \"not as described\" returns under 3%",
    body: "We are at 5.1%. Each return costs €38 (shipping both ways, retest, discount on resale) and a customer who rarely comes back. The two levers: AI grading that also covers the corners, and photos of the real phone rather than a stock picture.",
    entities: [pr("Returns"), pr("AI grading")],
  },
  {
    author: "leo", zone: "product", kind: "fact", daysAgo: 8, tool: "claude",
    title: "Customers choose on the battery, not on the cosmetic grade",
    body: "In the interviews and the A/B test, showing the battery health (for example 91%) on the product page lifted conversion by 18%, more than any photo. Hence the percentage on every listing, and the 85% minimum guaranteed.",
    entities: [pr("Product page")],
  },
  {
    author: "sarah", zone: "product", kind: "fact", daysAgo: 6, tool: "chatgpt",
    title: "Groupe Vallière considers a CSR report of the CO₂ avoided essential",
    body: "Their CSR team must report the impact of their IT equipment every quarter. Without a report per phone (kg of CO₂ and of e-waste avoided), no signature.",
    entities: [c("Groupe Vallière"), pr("CSR report")],
  },
  {
    author: "leo", zone: "product", kind: "task", daysAgo: 4, tool: "claude",
    title: "Write the spec of the automatic CSR report",
    body: "Kg of CO₂ and of e-waste avoided per phone (ADEME figures), totals per quarter and per site, PDF export and a link to share. Drafted by Claude from the orders, checked by Sarah before it goes out.",
    entities: [pr("CSR report"), t("Claude")],
  },
  {
    author: "leo", zone: "product", kind: "decision", daysAgo: 3, tool: "claude",
    title: "No refurbished laptops before April",
    body: "We stay on smartphones until returns are under 3%. MacBooks come in April, with Groupe Vallière as the pilot customer.",
    entities: [pr("Laptops"), pr("Returns"), c("Groupe Vallière")],
  },
  {
    author: "leo", zone: "product", kind: "fact", daysAgo: 2, tool: "claude",
    title: "Product goal: 30% of orders with a trade-in by the end of December",
    body: "Measured on the orders where the customer sends back their old phone for a discount. Each trade-in is also next quarter's stock. Tracked in the product dashboard.",
    entities: [pr("Trade-in")],
  },
  // --- Sales ---
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 7, tool: "chatgpt",
    title: "Groupe Vallière (1,200 employees) ready to sign if the CSR report ships in November",
    body: "Fleet of 800 refurbished phones leased over 2 years, buyback of their old phones included: about €290,000. Decision makers: the IT director and the CSR manager. Next step: CSR report demo on November 5.",
    entities: [c("Groupe Vallière"), pr("CSR report")],
  },
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 5, tool: "claude",
    title: "October B2B pipeline: 31 companies, 9 demos scheduled, 3 negotiations",
    body: "The three negotiations: Groupe Vallière, Kalia Santé and Transports Ondine. Demo → signature conversion rate of 28% over the quarter.",
    entities: [c("Groupe Vallière"), c("Kalia Santé"), c("Transports Ondine"), t("HubSpot")],
  },
  {
    author: "claire", zone: "sales", kind: "decision", daysAgo: 6, tool: "claude",
    title: "New B2B lease: €19 per phone per month over 24 months, buyback of the old fleet included",
    body: "Bought outright, a phone costs the shop price minus 10% from 50 units. In line with the leasing competitors and with the Q4 B2B goal. Quotes already signed keep their price until June.",
    entities: [pr("B2B leasing")],
  },
  {
    author: "sarah", zone: "sales", kind: "procedure", daysAgo: 4, tool: "claude",
    title: "Prepare an Encore B2B demo",
    body: "1. Create a demo company account from the admin (\"Demo\" button).\n2. Load a template fleet (60 iPhones and Samsungs over 3 sites).\n3. Show an employee ordering a phone, the buyback of the old one, then the fleet dashboard.\n4. End on the CSR report (Figma mockups until it ships).",
    entities: [t("Figma"), pr("CSR report")],
  },
  {
    author: "sarah", zone: "sales", kind: "task", daysAgo: 2, tool: "claude",
    title: "Follow up with Kalia Santé after the Fleet & Mobility convention",
    body: "Their 40 home-care nurses break a phone a month: they want a replacement within 48 hours included in the lease. Send the proposal before Friday.",
    entities: [c("Kalia Santé"), pr("B2B leasing")],
  },
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 1, tool: "chatgpt",
    title: "The Fleet & Mobility convention brings 40% of the year's B2B leads",
    body: "Budget the 2027 booth from January; register before December 15 for the discounted rate.",
    entities: [],
  },
  // --- Finance ---
  {
    author: "jeanmarc", zone: "finance", kind: "procedure", daysAgo: 9, tool: "claude",
    title: "Daily Qonto ↔ Pennylane bank reconciliation",
    body: "1. Export yesterday's Qonto transactions.\n2. Match them with the invoices and the Stripe and Alma payouts in Pennylane.\n3. List the variances (payment without an invoice, B2B invoice unpaid at D+30).\n4. Send the unpaid B2B invoices to Sarah for follow-up.",
    entities: [t("Qonto"), t("Pennylane"), t("Stripe"), t("Alma"), p("Sarah Cohen")],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "fact", daysAgo: 8, tool: "claude",
    title: "Month-end close: Pennylane export and stock valuation before the 5th for Durand Accounting",
    body: "The accountant (Durand Accounting) produces the monthly statement within 10 days from that export. Phones in stock are valued at their buyback price plus the parts used.",
    entities: [t("Pennylane"), c("Durand Accounting")],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "decision", daysAgo: 6, tool: "claude",
    title: "Phones bought back from individuals are sold under the VAT margin scheme",
    body: "VAT is only due on the margin (selling price minus buyback price), not on the whole price: about €21 less per phone. Every buyback keeps its record (seller's ID, IMEI, price paid) for the tax office.",
    entities: [t("Pennylane"), pr("Trade-in")],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "fact", daysAgo: 5, tool: "claude",
    title: "Monthly burn of about €95k, 11 months of runway as of October 1",
    body: "Excluding fundraising. The cash sits in stock (€420k of phones): we buy in the autumn for November and December, which bring 40% of the year's sales.",
    entities: [],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "fact", daysAgo: 4, tool: "claude",
    title: "Q3 2026 revenue: €1.86M, up 18% on Q2",
    body: "July €590k, August €545k, September €725k (back-to-school peak and the Groupe Vallière fleet order). 6,200 phones sold at €300 on average, gross margin 38%; business customers make 31% of revenue. Details in the Q3 revenue report.",
    entities: [c("Groupe Vallière"), { type: "doc", name: "Q3 2026 revenue report" }],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "task", daysAgo: 3, tool: "claude",
    title: "File the September VAT return before October 19",
    body: "Estimated amount: €38,400. Keep the margin scheme sales apart from those at normal VAT (business sales, accessories).",
    entities: [t("Pennylane")],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "fact", daysAgo: 2, tool: "claude",
    title: "Stripe payouts land on Qonto at D+7, Alma's at D+2",
    body: "To take into account in the cash forecast and in the daily reconciliation.",
    entities: [t("Stripe"), t("Alma"), t("Qonto")],
  },
  // --- Support ---
  {
    author: "hugo", zone: "support", kind: "procedure", daysAgo: 7, tool: "claude-code",
    title: "Transfer a customer's eSIM to their refurbished phone",
    body: "1. Both phones side by side, Wi-Fi on: Settings → Mobile service → Transfer eSIM.\n2. Old phone already sent back or broken: the customer requests a new eSIM QR code in their carrier's app.\n3. Scan the code on the new phone, then restart it.\n4. Still no network after 24 hours: open a \"network\" ticket in Zendesk with the IMEI.",
    entities: [pr("eSIM"), t("Zendesk")],
  },
  {
    author: "leo", zone: "support", kind: "fact", daysAgo: 4, tool: "claude",
    title: "Top 3 October tickets: battery draining, eSIM transfer, delivery delays",
    body: "1,240 tickets in total, 61% answered by the AI agent in Zendesk without a human. Battery draining is mostly the first 48 hours (the phone restores its backup): an email on day 1 would remove a third of them.",
    entities: [t("Zendesk"), pr("eSIM")],
  },
  {
    author: "sarah", zone: "support", kind: "task", daysAgo: 1, tool: "claude",
    title: "Write the FAQ on the battery draining during the first days",
    body: "Explain why a phone drains faster during its first 48 hours (backup restore, photo indexing) and when to ask for a battery check under warranty.",
    entities: [pr("Diagnostics"), pr("Product page")],
  },
  // --- Leadership ---
  {
    author: "claire", zone: "leadership", kind: "fact", daysAgo: 9, tool: "claude",
    title: "Q4 goal: 7,500 phones sold in November and December, and €1.2M of B2B signed",
    body: "We are at 2,100 phones a month and €410k of B2B signed as of October 1. Black Friday, the trade-in and Groupe Vallière are the three main levers.",
    entities: [c("Groupe Vallière"), pr("Trade-in")],
  },
  {
    author: "claire", zone: "leadership", kind: "decision", daysAgo: 7, tool: "claude",
    title: "Series A postponed to April 2027: we raise after Christmas",
    body: "November and December bring 40% of the year's sales: with 11 months of runway, we would rather raise with the Christmas numbers and the first big B2B contracts. The board approved it on October 2.",
    entities: [],
  },
  {
    author: "claire", zone: "leadership", kind: "task", daysAgo: 4, tool: "claude",
    title: "Hire a workshop lead by January",
    body: "The workshop goes from 12 to 20 technicians for the laptops in April: someone must own the benches, the parts stock and the grading quality. Job description to validate with Hugo, who built the workshop app.",
    entities: [p("Hugo Bernard"), pr("Laptops")],
  },
  {
    author: "claire", zone: "leadership", kind: "fact", daysAgo: 1, tool: "claude",
    title: "Quarterly board on November 12: revenue, gross margin per phone and return rate",
    body: "Jean-Marc prepares the financials, Léo the return rate.",
    entities: [p("Jean-Marc Dubois"), p("Léo Petit")],
  },
]

/**
 * The core: what anyone at Encore needs, whatever their zone (everyone reads it). Seeded after the rest, and added once
 * to a demo brain seeded before the core existed.
 */
export const DEMO_CORE_ITEMS: DemoItem[] = [
  {
    author: "claire", zone: "core", kind: "fact", daysAgo: 12, tool: "claude",
    title: "What Encore does: refurbished smartphones with a 2-year warranty",
    body: "Encore refurbishes smartphones and sells them online with a 2-year warranty, to individuals and to companies that equip their teams. Every phone is tested in the Lyon workshop: an AI grades the screen from photos, then a technician confirms. 2,100 phones sold a month, 40 business customers, 18 people (6 at the office, 12 technicians in the workshop).",
    entities: [pr("AI grading")],
  },
  {
    author: "claire", zone: "core", kind: "decision", daysAgo: 11, tool: "claude",
    title: "Vision: a refurbished phone people trust as much as a new one, for half the price",
    body: "Our bet: by 2028, one phone out of five used for work in France is refurbished. We win it on trust rather than on price: every phone tested, graded honestly, guaranteed 2 years. After phones, laptops in April 2027, with the same promise.",
    entities: [pr("Laptops")],
  },
  {
    author: "claire", zone: "core", kind: "fact", daysAgo: 11, tool: "claude",
    title: "Our three rules: grade honestly, hide nothing, protect the workshop",
    body: "1. Grade honestly: when in doubt, the lower grade; a disappointed customer costs more than a lower price.\n2. Hide nothing: battery health, scratches and the grade are shown before the purchase.\n3. Protect the workshop: nothing ships or deploys that disrupts the benches during workshop hours (8am to 6pm).",
    entities: [],
  },
  {
    author: "claire", zone: "core", kind: "procedure", daysAgo: 6, tool: "claude",
    title: "Who to ask at Encore",
    body: "Claire Martin (CEO): strategy, fundraising, hiring. Hugo Bernard (lead dev): the shop, the API, the workshop app. Jean-Marc Dubois: invoicing, cash, payroll. Sarah Cohen: business customers and quotes. Léo Petit: roadmap, product pages, the return rate.",
    entities: [p("Claire Martin"), p("Hugo Bernard"), p("Jean-Marc Dubois"), p("Sarah Cohen"), p("Léo Petit")],
  },
  {
    author: "claire", zone: "core", kind: "fact", daysAgo: 3, tool: "claude",
    title: "Key figures everyone should know",
    body: "2,100 phones sold a month at €300 on average, gross margin 38%. Business customers make 31% of revenue; the largest is Groupe Vallière. Q4 goal: 7,500 phones in November and December.",
    entities: [c("Groupe Vallière")],
  },
  {
    author: "claire", zone: "core", kind: "fact", daysAgo: 10, tool: "claude",
    title: "Our customers: individuals online, and companies that equip their teams",
    body: "Individuals buy on the online shop, in one go or in 3 or 4 installments with Alma. Companies equip their teams through Sarah's B2B team: a fleet of phones, one invoice, a 48-hour replacement when a phone fails. 40 business customers today, 31% of revenue.",
    entities: [t("Alma"), p("Sarah Cohen")],
  },
  {
    author: "claire", zone: "core", kind: "procedure", daysAgo: 9, tool: "claude",
    title: "Your first week at Encore",
    body: "1. Day one at the Lyon workshop: a morning on a bench with a technician, to see how a phone is tested and graded.\n2. Read the core of the brain: what we do, our rules, who to ask.\n3. Your manager opens your zones; your agents (Claude Code, Codex) read the same brain as you.\n4. By Friday, follow one phone end to end, from its buyback to its delivery.",
    entities: [],
  },
  {
    author: "claire", zone: "core", kind: "fact", daysAgo: 8, tool: "claude",
    title: "The workshop sets the pace: benches open from 8am to 6pm",
    body: "Every phone goes through the Lyon workshop: tested, photographed, graded by the AI then confirmed by a technician, packed. The 12 technicians work from 8am to 6pm: no deployment, no shipping change and no meeting with them during those hours. The office (6 people) works around the workshop, not the other way round.",
    entities: [pr("AI grading")],
  },
  {
    author: "claire", zone: "core", kind: "fact", daysAgo: 7, tool: "claude",
    title: "Encore words: grade, trade-in, fleet, \"not as described\"",
    body: "Grade: Excellent, Very good or Fair, proposed by the AI from the photos, confirmed by the technician. Trade-in: we buy back a customer's old phone, which becomes next quarter's stock. Fleet: the phones a company rents or buys for its team. \"Not as described\": a return because the phone does not match its grade, the one we fight first.",
    entities: [pr("Trade-in"), pr("AI grading")],
  },
  {
    author: "claire", zone: "core", kind: "decision", daysAgo: 2, tool: "claude",
    title: "This quarter's three priorities, for everyone",
    body: "1. Sell 7,500 phones in November and December, and sign €1.2M of B2B.\n2. Bring \"not as described\" returns under 3%.\n3. Nothing that slows the workshop down before Christmas. Laptops come after, in April 2027.",
    entities: [pr("Laptops")],
  },
]

/** Typical prompts per zone, for the history and the simulator. */
/**
 * Documents sent with the knowledge: the file a session worked on (here, the quarterly report Jean-Marc wrote with
 * Claude), kept in the brain next to the facts drawn from it. `items`: titles of the knowledge it backs.
 */
export type DemoDocument = {
  author: string
  zone: string
  name: string
  title: string
  daysAgo: number
  items: string[]
  lines: { text: string; size?: number; bold?: boolean }[]
}

export const DEMO_DOCUMENTS: DemoDocument[] = [
  {
    author: "jeanmarc", zone: "finance", daysAgo: 4,
    name: "encore-revenue-Q3-2026.pdf",
    title: "Encore — Q3 2026 revenue report",
    items: ["Q3 2026 revenue: €1.86M, up 18% on Q2", "Monthly burn of about €95k, 11 months of runway as of October 1"],
    lines: [
      { text: "Encore — Quarterly revenue report, Q3 2026", size: 18, bold: true },
      { text: "Prepared by Jean-Marc Dubois, Finance · October 2026", size: 10 },
      { text: "" },
      { text: "Revenue: €1,860,000 (+18% vs Q2 2026)", size: 13, bold: true },
      { text: "July: €590,000 · 1,960 phones" },
      { text: "August: €545,000 · 1,830 phones" },
      { text: "September: €725,000 · 2,410 phones" },
      { text: "" },
      { text: "Mix: individuals 69% · business customers 31% (40 accounts)" },
      { text: "Gross margin: 38% (VAT margin scheme on phones bought back from individuals)" },
      { text: "Average selling price: €300 · return rate under warranty: 4.1%" },
      { text: "" },
      { text: "Highlights", size: 13, bold: true },
      { text: "- Back-to-school peak in September; Groupe Vallière fleet order of 180 phones." },
      { text: "- Trade-in is now 22% of supply, bought back at €96 on average." },
      { text: "- Stripe payouts land on Qonto at D+7, Alma's at D+2: cash forecast updated." },
      { text: "" },
      { text: "Outlook Q4", size: 13, bold: true },
      { text: "November and December bring 40% of the year's sales: €420k of stock bought in the autumn." },
      { text: "Monthly burn of about €95k, 11 months of runway as of October 1 (excluding fundraising)." },
    ],
  },
]

export const DEMO_PROMPTS: Record<string, { user: string; text: string }[]> = {
  dev: [
    { user: "hugo", text: "Why is the Stripe charge.refunded webhook failing in prod this morning?" },
    { user: "ines", text: "Make the grading prompt also flag the dents on the frame's corners" },
    { user: "hugo", text: "Prepare the Supabase migration for the returns table" },
    { user: "ines", text: "Write the Playwright tests for the Alma installment checkout" },
  ],
  product: [
    { user: "leo", text: "Write the spec of the automatic CSR report for business customers" },
    { user: "leo", text: "Sort this week's \"not as described\" returns by cause" },
  ],
  sales: [
    { user: "sarah", text: "Prepare a lease proposal for Kalia Santé's 40 nurses" },
    { user: "sarah", text: "Summarize the B2B pipeline and the deals in negotiation this week" },
  ],
  finance: [
    { user: "jeanmarc", text: "Prepare the September VAT return, margin scheme sales apart" },
    { user: "jeanmarc", text: "Update the cash forecast with the stock bought for Black Friday" },
  ],
  support: [
    { user: "hugo", text: "Why can't the customer of order 48213 transfer their eSIM?" },
    { user: "sarah", text: "Write the answer to the ticket about a battery that drains in a day" },
  ],
  leadership: [
    { user: "claire", text: "Prepare the gross margin and return rate KPIs for the November 12 board" },
    { user: "claire", text: "Where do we stand on the quarter's goals?" },
  ],
}

/**
 * What only Screenpipe brings: meetings transcribed on the computer, AI chats in the browser (no logs to read) and
 * what the computer's Screenpipe agent found by itself in the recent activity. Added to an existing demo brain too.
 */
export const DEMO_SCREENPIPE_ITEMS: DemoItem[] = [
  {
    author: "claire", zone: "leadership", kind: "decision", daysAgo: 2, tool: "meeting", app: "Google Meet",
    title: "Weekly sync: Black Friday prices freeze on November 17",
    body: "Decided in Monday's team meeting (Claire, Hugo, Léo, Sarah): the pricing job stops changing prices on November 17 and the Black Friday stock (2,000 iPhones 13 and 14) is bought this week. Hugo adds the freeze switch, Jean-Marc releases the cash, Léo writes the landing page.",
    entities: [pr("Black Friday"), pr("Pricing engine"), p("Hugo Bernard"), p("Léo Petit")],
  },
  {
    author: "sarah", zone: "sales", kind: "decision", daysAgo: 1, tool: "meeting", app: "Zoom",
    title: "Kalia Santé: 40-phone pilot at €21 per month with a 48-hour replacement",
    body: "Call with Kalia Santé: they start with 40 phones in December if a broken phone is replaced within 48 hours anywhere in France. Sarah promised a written answer on the replacement stock by Friday.",
    entities: [c("Kalia Santé"), pr("B2B leasing"), pr("48-hour replacement")],
  },
  {
    author: "leo", zone: "product", kind: "fact", daysAgo: 3, tool: "meeting", app: "Google Meet",
    title: "Customer interviews: people leave the cart for fear of losing their data, not because of the price",
    body: "Five interviews with visitors who abandoned their cart: three were afraid of not managing to move their eSIM and their WhatsApp chats. A \"we help you move your data\" step goes into the checkout.",
    entities: [pr("Checkout"), pr("eSIM")],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "procedure", daysAgo: 4, tool: "chatgpt", app: "Google Chrome",
    title: "Invoice phones sold to Belgian companies",
    body: "A phone bought back from an individual stays under the margin scheme even when a Belgian company buys it: French VAT on the margin, no reverse charge, and the invoice says \"Margin scheme – second-hand goods\". Only phones bought from professionals go out without VAT, with the client's EU VAT number. Worked out with ChatGPT in the browser, confirmed by the accountant.",
    entities: [t("ChatGPT"), t("Pennylane"), pr("EU sales")],
  },
  {
    author: "hugo", zone: "dev", kind: "fact", daysAgo: 1, tool: "agent", app: "Screenpipe",
    title: "Staging migration 0042 times out on the orders index",
    body: "Found by the Screenpipe agent across two days of Hugo's terminal and Vercel dashboard: the staging deploy failed three times on the same migration. Creating the orders index concurrently fixed it; to do the same in production before Black Friday.",
    entities: [t("Supabase"), t("Vercel"), pr("Black Friday")],
  },
  {
    author: "sarah", zone: "support", kind: "fact", daysAgo: 2, tool: "agent", app: "Screenpipe",
    title: "Four support chats this week about WhatsApp chats lost after switching phones",
    body: "Found by the Screenpipe agent in Sarah's support inbox: four customers moving from Android to iPhone lost their WhatsApp history. The answer to give: WhatsApp's transfer only works during the first setup, so reset the phone and run \"Move to iOS\" first.",
    entities: [pr("Data transfer"), t("Zendesk")],
  },
]

/** Repetitive workflows detected by Screenpipe on the computers (as brain-sync reports them to /api/automations). */
export const DEMO_WORKFLOWS: {
  user: string
  id: string
  zone: string
  title: string
  description: string
  schedule: string
  occurrences: number
  days: number
  minutes_saved_per_week: number
}[] = [
  {
    user: "sarah", id: "wf-tradeshow-leads", zone: "sales",
    title: "Copy the trade-show leads from the spreadsheet into HubSpot",
    description: "Detected by Screenpipe on Sarah's computer: every Monday, the same sequence between Google Sheets and HubSpot, one company at a time. Proposal: import the sheet automatically and only show Sarah the duplicates.",
    schedule: "Mondays around 10:00", occurrences: 4, days: 4, minutes_saved_per_week: 45,
  },
  {
    user: "leo", id: "wf-store-reviews", zone: "product",
    title: "Sort the Trustpilot reviews into the product backlog",
    description: "Detected by Screenpipe on Léo's computer: every Friday afternoon, Trustpilot then Linear, review by review. Proposal: a weekly digest of the reviews, already grouped by topic (battery, grade, delivery), as Linear issues.",
    schedule: "Fridays around 16:30", occurrences: 3, days: 3, minutes_saved_per_week: 30,
  },
]

/** The prompt Jean-Marc runs every morning around 9am: the demo's automation suggestion. */
export const JEANMARC_DAILY_PROMPT = "Reconcile yesterday's Qonto statements with the Pennylane invoices and list the variances"

/** Encore's skills: `zone` is the cortex that receives them (null: the whole company). */
export type DemoSkill = { author: string; name: string; description: string; zone: string | null; daysAgo: number; version?: number; files: SkillFile[] }

export const DEMO_SKILLS: DemoSkill[] = [
  {
    author: "claire", name: "encore-tone", zone: null, daysAgo: 9,
    description: "Write an email, a post or a customer reply in Encore's tone. Use it for any text meant for a customer.",
    files: [
      {
        path: "SKILL.md",
        content: `# Encore's tone

Our customers bought a phone that had a first life: they want to be reassured, not sold to.

- Short sentences, one message = one idea, polite and warm.
- Talk about their phone (battery, grade, warranty), never about a "device", a "unit" or "second-hand".
- When it helps, say what the warranty covers: 2 years, battery included.
- No emoji, no exclamation mark.
- End with a clear action and a date when there is one.
- Sign with the person's first name, followed by "the Encore team".
`,
      },
    ],
  },
  {
    author: "hugo", name: "deploy-encore", zone: "dev", daysAgo: 8, version: 3,
    description: "Deploy Encore to production (tag, Vercel, Sentry watch) and roll back if needed.",
    files: [
      {
        path: "SKILL.md",
        content: `# Deploy Encore to production

1. Check that main is green: \`gh run list --branch main --limit 1\`.
2. Run \`scripts/release.sh <version>\`: it creates the vX.Y.Z tag, Vercel deploys the shop and the API.
3. Watch Sentry for 15 minutes (\`scripts/release.sh --watch\`).
4. If there is a new error: promote the previous release on Vercel, then tell #dev.

Supabase migrations are applied by CI on staging before the tag: never run them by hand in prod.
The workshop app never ships with this tag: it updates at night, never during workshop hours (8am to 6pm).
`,
      },
      {
        path: "scripts/release.sh",
        content: `#!/usr/bin/env bash
# Creates the release tag (Vercel deploys prod on the tag), or watches Sentry with --watch.
set -euo pipefail

if [[ "\${1:-}" == "--watch" ]]; then
  echo "New Sentry errors in the last 15 minutes:"
  sentry-cli issues list --project encore-shop --query "firstSeen:-15m" --status unresolved
  exit 0
fi

version="\${1:?usage: release.sh 1.42.0}"
git fetch origin main --tags
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Check out an up-to-date origin/main before tagging." >&2
  exit 1
fi
git tag -a "v$version" -m "Release v$version"
git push origin "v$version"
echo "Tag v$version pushed: Vercel deploys prod. Then run: $0 --watch"
`,
      },
    ],
  },
  {
    author: "jeanmarc", name: "qonto-pennylane-reconciliation", zone: "finance", daysAgo: 5, version: 2,
    description: "Reconcile yesterday's Qonto transactions with the Pennylane invoices and list the variances to follow up.",
    files: [
      {
        path: "SKILL.md",
        content: `# Qonto ↔ Pennylane reconciliation

Every morning, for the previous day:

1. Run \`python3 scripts/variances.py --day yesterday\`: it reads the Qonto export (CSV) and the Pennylane invoices export.
2. Review the variances: payment without an invoice, B2B invoice unpaid at D+30, incomplete Stripe or Alma payout.
3. Send the list of B2B invoices to follow up to Sarah (sales).

Stripe payouts land on Qonto at D+7 and Alma's at D+2: a more recent variance is not one.
`,
      },
      {
        path: "scripts/variances.py",
        content: `#!/usr/bin/env python3
"""Variances between the Qonto export and the Pennylane invoices (CSV files exported to ~/Finance/exports)."""
import argparse
import csv
import datetime as dt
from pathlib import Path

EXPORTS = Path.home() / "Finance" / "exports"


def read(name):
    with open(EXPORTS / name, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter=";"))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--day", default="yesterday", help="yesterday, or a YYYY-MM-DD date")
    args = p.parse_args()
    day = dt.date.today() - dt.timedelta(days=1) if args.day == "yesterday" else dt.date.fromisoformat(args.day)
    transactions = [t for t in read(f"qonto-{day}.csv") if t["direction"] == "credit"]
    invoices = {f["number"]: f for f in read("pennylane-invoices.csv")}
    for t in transactions:
        number = t["reference"].strip()
        if number not in invoices:
            print(f"Payment without an invoice: €{t['amount']} ({t['label']})")
    for f in invoices.values():
        due = dt.date.fromisoformat(f["due_date"])
        if f["status"] != "paid" and (day - due).days > 30:
            print(f"To follow up: invoice {f['number']} ({f['customer']}, €{f['amount']})")


if __name__ == "__main__":
    main()
`,
      },
    ],
  },
  {
    author: "claire", name: "prepare-customer-demo", zone: "sales", daysAgo: 4,
    description: "Prepare the Encore demo for a business prospect: demo company account, template fleet, a 20-minute run-through.",
    files: [
      {
        path: "SKILL.md",
        content: `# Prepare a business customer demo

1. Create a demo company account from the admin ("Demo" button), named after the prospect.
2. Load a template fleet (60 iPhones and Samsungs over 3 sites).
3. Run-through: an employee orders a phone, the buyback of the old one, the fleet dashboard, then the CSR report.
4. Record in the brain what the prospect asked for (Sales zone), with the next step and its date.
`,
      },
    ],
  },
  {
    author: "hugo", name: "transfer-esim", zone: "support", daysAgo: 3,
    description: "Guide a customer who cannot move their eSIM to their refurbished phone.",
    files: [
      {
        path: "SKILL.md",
        content: `# Transfer an eSIM

1. Both phones side by side, Wi-Fi on: Settings → Mobile service → Transfer eSIM.
2. Old phone already sent back or broken: the customer requests a new eSIM QR code in their carrier's app.
3. Scan the code on the new phone, then restart it.
4. Still no network after 24 hours: open a "network" ticket in Zendesk with the IMEI.
`,
      },
    ],
  },
]

/**
 * What the team did with its brain in the ten days after the demo's last knowledge: the open threads close (the VAT
 * return, Kalia Santé, the frame's corners, the CSR report), each agent finds what a colleague wrote before acting,
 * and the Screenpipe agent sees the effect. Dated from the latest knowledge in the brain (`daysAfter`, at `hour`,
 * local time), so a demo that stopped catches up. `asked`: the prompt typed in the agent; `searched`: what the agent
 * then asked the brain (search_brain), in `searchZones`.
 */
export type DemoFollowup = Omit<DemoItem, "daysAgo"> & {
  daysAfter: number
  hour: number
  asked?: string
  searched?: string
  searchZones?: string[]
  /** Tasks this knowledge closes (their exact titles). */
  closes?: string[]
}

export const DEMO_FOLLOWUP_ITEMS: DemoFollowup[] = [
  {
    author: "jeanmarc", zone: "finance", kind: "fact", daysAfter: 0, hour: 17, tool: "claude-code",
    title: "September VAT return filed: €38,400 paid, margin-scheme sales declared apart",
    body: "Filed from Pennylane before the October 19 deadline. Phones bought back from individuals go under the margin scheme (VAT on the margin only); new phones and accessories at 20%. October's return is due before November 19.",
    entities: [t("Pennylane"), pr("VAT margin scheme")],
    asked: "Prepare the September VAT return, margin scheme sales apart",
    searched: "VAT margin scheme phones bought back from individuals",
    searchZones: ["finance"],
    closes: ["File the September VAT return before October 19"],
  },
  {
    author: "hugo", zone: "dev", kind: "procedure", daysAfter: 3, hour: 7, tool: "claude-code",
    title: "Run migration 0042 in production without locking the orders table",
    body: "1. Create the orders index CONCURRENTLY, in its own migration, outside the transaction.\n2. Then run 0042.\n3. Before 8am, when the workshop opens.\nDone before the workshop opened: 4 minutes, no lock, no failed order. The same recipe for any index on a large table before Black Friday.",
    entities: [t("Supabase"), t("Postgres"), pr("Black Friday")],
    asked: "Run the orders migration in production",
    searched: "orders migration 0042 staging timeout",
    searchZones: ["dev"],
  },
  {
    author: "ines", zone: "dev", kind: "fact", daysAfter: 3, hour: 14, tool: "claude-code",
    title: "First release shipped by Inès alone: the deploy procedure was enough",
    body: "v2.14.0: tag, Vercel deploy, 15 minutes of Sentry watch, step by step from Hugo's procedure, without asking him. One step was missing and is now in it: purge the CDN cache of the product images.",
    entities: [t("Vercel"), t("Sentry"), p("Hugo Bernard")],
    asked: "How do we ship the shop to production?",
    searched: "deploy the shop to production",
    searchZones: ["dev"],
  },
  {
    author: "sarah", zone: "sales", kind: "decision", daysAfter: 3, hour: 16, tool: "claude",
    title: "Kalia Santé signs the pilot: 40 phones from December 1, then the whole fleet",
    body: "Signed after the written answer on the replacement stock: €21 per phone per month, a broken phone replaced within 48 hours anywhere in France (12 phones kept in stock for them). If the pilot holds three months, 220 more phones in March.",
    entities: [c("Kalia Santé"), pr("B2B leasing"), pr("48-hour replacement")],
    asked: "Write Kalia Santé the answer on the 48-hour replacement stock",
    searched: "48-hour replacement for business customers",
    searchZones: ["sales", "support"],
    closes: ["Follow up with Kalia Santé after the Fleet & Mobility convention"],
  },
  {
    author: "leo", zone: "product", kind: "decision", daysAfter: 4, hour: 10, tool: "claude-code",
    title: "The grading model now checks the frame's corners",
    body: "Answers Inès's question about the corners: dents on the corners were behind one \"not as described\" return in four. The bench takes a fifth photo, of the corners; the technician confirms as before. Expected: the return rate from 5.1% to under 4% by December.",
    entities: [pr("AI grading"), pr("Returns"), p("Inès Lefèvre")],
    asked: "Should we grade the frame's corners too? Check the returns",
    searched: "frame corners dents not as described returns",
    searchZones: ["product", "dev", "support"],
  },
  {
    author: "sarah", zone: "support", kind: "procedure", daysAfter: 4, hour: 15, tool: "claude",
    title: "Answer a customer whose new phone drains its battery in the first days",
    body: "1. Normal for 48 to 72 hours: the phone indexes its photos and syncs iCloud or Google.\n2. Ask for the battery health (Settings → Battery): 85% or more, nothing to do.\n3. Below: individuals get a prepaid label, companies on a lease a replacement within 48 hours.\nPublished as a help center FAQ.",
    entities: [t("Zendesk"), pr("48-hour replacement")],
    asked: "Write the FAQ on the battery draining during the first days",
    searched: "battery draining new phone first days",
    searchZones: ["support", "product"],
    closes: ["Write the FAQ on the battery draining during the first days"],
  },
  {
    author: "claire", zone: "leadership", kind: "decision", daysAfter: 4, hour: 18, tool: "meeting", app: "Google Meet",
    title: "Weekly sync: the 2,000 Black Friday iPhones graded by November 14",
    body: "Decided in the weekly team meeting: the workshop grades the 2,000 Black Friday iPhones by November 14, 200 a day, with the corners check from day one. Hugo creates the remaining indexes before then, Jean-Marc pays the stock with the cards' November ceiling.",
    entities: [pr("Black Friday"), p("Hugo Bernard"), p("Jean-Marc Dubois"), t("Qonto")],
  },
  {
    author: "hugo", zone: "dev", kind: "task", daysAfter: 5, hour: 9, tool: "codex",
    title: "Create the Black Friday indexes on orders and payments before November 14",
    body: "Same recipe as migration 0042 (concurrently, before 8am): orders by status and date, payments by provider. To watch in Supabase for a day after each one.",
    entities: [t("Supabase"), pr("Black Friday")],
    asked: "List the indexes we still need before Black Friday",
    searched: "migration production without lock orders index",
    searchZones: ["dev"],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "fact", daysAfter: 5, hour: 11, tool: "claude-code",
    title: "Kalia Santé billing set up in Pennylane: one invoice a month, the first on December 1",
    body: "40 phones × €21, the 48-hour replacement included; their purchase order number on every invoice, sent to their accounting. Terms taken from the signed pilot.",
    entities: [c("Kalia Santé"), t("Pennylane")],
    asked: "Set up the monthly invoice for Kalia Santé's lease",
    searched: "Kalia Santé lease invoice",
    searchZones: ["finance"],
  },
  {
    author: "leo", zone: "product", kind: "fact", daysAfter: 5, hour: 16, tool: "agent", app: "Screenpipe",
    title: "Trade-ins reach 24% of October's orders",
    body: "Found by the Screenpipe agent in Léo's Amplitude dashboard: 24% of October's orders came with a trade-in, against 19% in September. The goal is 30% by the end of December.",
    entities: [pr("Trade-in"), t("Amplitude")],
  },
  {
    author: "sarah", zone: "sales", kind: "fact", daysAfter: 6, hour: 11, tool: "meeting", app: "Zoom",
    title: "Groupe Vallière demo: they sign 1,200 phones if a sample CSR report ships by November 20",
    body: "Demo with their purchasing and CSR leads: the lease terms suit them. They want a sample of the CO₂ report for their first 100 phones before signing, by November 20.",
    entities: [c("Groupe Vallière"), pr("CSR report"), pr("B2B leasing")],
  },
  {
    author: "leo", zone: "product", kind: "procedure", daysAfter: 6, hour: 15, tool: "claude-code",
    title: "CSR report: the CO₂ avoided, computed phone by phone",
    body: "Per phone: the CO₂ of a new one of the same model (manufacturer data), minus the refurbishing footprint (transport, parts, 0.8 kg for the bench). Summed per fleet, as a monthly PDF for each business customer. First sample for Groupe Vallière on November 20.",
    entities: [pr("CSR report"), c("Groupe Vallière")],
    asked: "Finish the spec of the CSR report for business customers",
    searched: "Groupe Vallière CSR report CO2 requirements",
    searchZones: ["product", "sales"],
    closes: ["Write the spec of the automatic CSR report"],
  },
  {
    author: "ines", zone: "dev", kind: "fact", daysAfter: 7, hour: 12, tool: "claude-code",
    title: "Playwright tests now cover the checkout paid in installments with Alma",
    body: "Three tests: 3 and 4 installments, and a refusal by Alma. They run on every pull request in GitHub Actions, in about 2 minutes, and caught a missing return URL on a staging preview the same day.",
    entities: [t("Playwright"), t("Alma"), t("GitHub")],
    asked: "Write the Playwright tests for the Alma installment checkout",
    searched: "Alma installment checkout",
    searchZones: ["dev"],
    closes: ["Add Playwright e2e tests on the checkout paid in installments with Alma"],
  },
  {
    author: "hugo", zone: "dev", kind: "decision", daysAfter: 7, hour: 16, tool: "claude-code",
    title: "Refunds wait for the workshop's scan, not for Stripe's webhook",
    body: "From now on, a refund starts when the workshop scans the returned phone; Stripe's charge.refunded only updates the order. It ends the refunds paid for phones that never came back (6 this month).",
    entities: [t("Stripe"), pr("Returns")],
    asked: "Fix the refunds that go out before the phone is back",
    searched: "Stripe charge.refunded webhook before the return",
    searchZones: ["dev", "support"],
  },
  {
    author: "claire", zone: "leadership", kind: "fact", daysAfter: 7, hour: 18, tool: "claude",
    title: "Board of November 12: the deck is drafted",
    body: "Q3 revenue €1.86M (+18%), a €95k monthly burn and 11 months of runway; a 5.1% return rate and the plan to bring it under 4% with the corners check; Kalia Santé signed, Groupe Vallière waiting for its CSR sample; trade-ins at 24% of orders.",
    entities: [pr("Board"), c("Kalia Santé"), c("Groupe Vallière")],
    asked: "Draft the November 12 board deck from the quarter's figures",
    searched: "Q3 revenue burn runway return rate trade-in",
    searchZones: ["finance", "product", "sales", "leadership"],
  },
  {
    author: "sarah", zone: "support", kind: "fact", daysAfter: 10, hour: 9, tool: "agent", app: "Screenpipe",
    title: "Battery tickets halved in the week after the FAQ: 31 to 14",
    body: "Found by the Screenpipe agent in Sarah's Zendesk: 14 tickets about a battery draining in the first days, against 31 the week before the FAQ. Most now close with the FAQ's link.",
    entities: [t("Zendesk"), pr("Battery")],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "fact", daysAfter: 10, hour: 10, tool: "claude-code",
    title: "Cash forecast updated with the Black Friday stock: 10 months of runway",
    body: "The 2,000 iPhones cost €0.62M, paid in November with the Qonto cards' raised ceiling: runway goes from 11 to 10 months, back to 11 with December's sales.",
    entities: [t("Qonto"), pr("Black Friday")],
    asked: "Update the cash forecast with the stock bought for Black Friday",
    searched: "Black Friday stock 2,000 iPhones Qonto ceiling",
    searchZones: ["finance"],
  },
  {
    author: "leo", zone: "product", kind: "question", daysAfter: 10, hour: 11, tool: "claude-code",
    title: "Should the CSR report count the phone's second life after the lease?",
    body: "A leased phone is bought back and resold after 24 months: counting that second life would double the CO₂ avoided, but Groupe Vallière's CSR lead wants a figure an auditor accepts. To settle before the November 20 sample.",
    entities: [pr("CSR report"), c("Groupe Vallière")],
  },
]

/** Agents that only read the brain (no knowledge written): the colleague's answer was already there. */
export const DEMO_FOLLOWUP_SEARCHES: { daysAfter: number; hour: number; user: string; agent: "claude-code" | "codex"; asked: string; searched: string; zones: string[] }[] = [
  { daysAfter: 3, hour: 10, user: "sarah", agent: "claude-code", asked: "What did we promise Kalia Santé on replacements?", searched: "Kalia Santé pilot 48-hour replacement", zones: ["sales"] },
  { daysAfter: 4, hour: 9, user: "ines", agent: "claude-code", asked: "Restore last night's backup on staging", searched: "restore a Supabase backup on staging", zones: ["dev"] },
  { daysAfter: 5, hour: 14, user: "hugo", agent: "codex", asked: "Why can't this customer move their eSIM?", searched: "transfer eSIM refurbished phone", zones: ["support"] },
  { daysAfter: 6, hour: 10, user: "leo", agent: "claude-code", asked: "What do customers choose on, grade or battery?", searched: "customers choose battery cosmetic grade", zones: ["product"] },
  { daysAfter: 7, hour: 10, user: "sarah", agent: "claude-code", asked: "Prepare the B2B demo for a school group", searched: "prepare an Encore B2B demo lease price", zones: ["sales"] },
  { daysAfter: 10, hour: 9, user: "hugo", agent: "claude-code", asked: "Can I deploy at 10am today?", searched: "deploy rules workshop hours", zones: ["dev", "core"] },
  { daysAfter: 10, hour: 10, user: "claire", agent: "claude-code", asked: "Where do we stand on the quarter's goals?", searched: "Q4 goal phones sold B2B signed", zones: ["leadership", "sales"] },
]
