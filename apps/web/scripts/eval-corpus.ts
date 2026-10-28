// Extra knowledge for the search evaluation, loaded into a local Encore demo by npm run eval:seed. The demo's 51 items
// leave too little competition: these are near misses in every zone (deploying the internal admin rather than the shop,
// restoring a Notion page rather than the database, VAT on accessories rather than on buybacks…), plus older versions of
// four decisions, superseded by the current ones: search must never serve them.
// None of these titles contains an answer the cases expect: npm run eval:seed checks it.

import type { Entity, KnowledgeItemInput } from "@brain/core"
import type { DemoPerson } from "./eval-cases"

/** Marks the corpus in the store: the evaluation runs its corpus sets only when this item is there. */
export const CORPUS_MARKER = "Encore's office address and opening hours"

export type CorpusItem = Omit<KnowledgeItemInput, "source" | "confidence"> & { by: DemoPerson }

const t = (name: string): Entity => ({ type: "tool", name })
const c = (name: string): Entity => ({ type: "client", name })
const pr = (name: string): Entity => ({ type: "project", name })

export const CORPUS_ITEMS: CorpusItem[] = [
  // dev
  { by: "hugo", zone: "dev", kind: "procedure", title: "Ship the back-office admin to staging", body: "1. Merge into develop.\n2. Vercel builds a preview of the admin.\n3. Check the orders list loads, then share the preview link in #dev. No tag, no Sentry watch: the admin is internal.", entities: [t("Vercel"), t("GitHub")] },
  { by: "hugo", zone: "dev", kind: "procedure", title: "Pause a bad release of the iOS app", body: "In App Store Connect, pause the phased release, then submit the previous build as an expedited review. The web shop is not affected.", entities: [t("App Store Connect")] },
  { by: "ines", zone: "dev", kind: "procedure", title: "Recover a deleted Notion page", body: "Notion keeps deleted pages 30 days in the trash: Settings → Trash, search the title, Restore. After 30 days, ask Hugo, who exports the workspace weekly.", entities: [t("Notion")] },
  { by: "hugo", zone: "dev", kind: "fact", title: "Sentry pages Hugo when checkout errors pass 2%", body: "The alert looks at the share of failed payments over 10 minutes. Below 2% it only posts in #dev.", entities: [t("Sentry"), pr("Checkout")] },
  { by: "hugo", zone: "dev", kind: "decision", title: "Database connections go through Supabase's pooler", body: "After the connection timeouts of Black Friday 2025, every serverless function connects through the pooler on port 6543, never directly.", entities: [t("Supabase"), t("Postgres"), pr("Black Friday")] },
  { by: "ines", zone: "dev", kind: "fact", title: "The orders API answers 409 when a phone is already reserved", body: "Two customers can put the same phone in their cart; the second payment gets a 409 and the shop offers the next phone of the same grade.", entities: [pr("Checkout")] },
  { by: "ines", zone: "dev", kind: "task", title: "Upgrade Next.js on the shop before November", body: "Two major versions behind; do it before the price freeze so Black Friday runs on the new version.", entities: [t("Next.js")] },
  { by: "hugo", zone: "dev", kind: "fact", title: "Staging data is anonymized every Sunday night", body: "Names, emails, addresses and IMEIs are replaced in the Sunday copy of production; never copy production to staging by hand.", entities: [t("Supabase")] },
  { by: "hugo", zone: "dev", kind: "decision", title: "Feature flags live in the database, not in environment variables", body: "A flag can then change without a redeploy; the admin lists them under Settings → Flags.", entities: [t("Supabase")] },
  { by: "hugo", zone: "dev", kind: "procedure", title: "Rotate the Stripe API keys", body: "Create the new restricted key in Stripe, set it in Vercel, redeploy, then revoke the old key the next day.", entities: [t("Stripe"), t("Vercel")] },
  // product
  { by: "leo", zone: "product", kind: "fact", title: "A/B test: the free shipping banner changed nothing", body: "Two weeks, 41,000 visitors: conversion 2.31% with the banner, 2.29% without. Removed.", entities: [pr("Product page")] },
  { by: "leo", zone: "product", kind: "decision", title: "From January, listings show photos of the real phone", body: "Stock images go away: the bench photos become the listing photos. Costs one more photo per phone.", entities: [pr("Product page")] },
  { by: "leo", zone: "product", kind: "fact", title: "Phones in grade Fair sell 12% slower than Very good", body: "Measured over Q3 on the 20 best-selling models; the price gap does not make up for it.", entities: [pr("Product page")] },
  { by: "leo", zone: "product", kind: "task", title: "Add a battery health filter to the catalogue", body: "Filter by 85%, 90% and 95% and above, next to the grade filter.", entities: [pr("Product page")] },
  { by: "leo", zone: "product", kind: "fact", title: "Buyback quotes for old phones are accepted 62% of the time", body: "Most refusals come right after the photo step, when the quote drops for a cracked back.", entities: [pr("Trade-in")] },
  { by: "leo", zone: "product", kind: "question", title: "Should we sell refurbished iPads before MacBooks?", body: "Same workshop process as phones, fewer parts. Would test the B2B appetite for tablets before April.", entities: [pr("Laptops")] },
  { by: "leo", zone: "product", kind: "fact", title: "The 2-year warranty badge lifts conversion by 7%", body: "A/B test in September on the product page; the badge stays on every listing.", entities: [pr("Product page")] },
  // sales
  { by: "sarah", zone: "sales", kind: "fact", title: "Transports Ondine wants 120 phones with rugged cases", body: "Drivers drop their phones: rugged cases and screen protectors in the lease. Quote expected next week.", entities: [c("Transports Ondine")] },
  { by: "sarah", zone: "sales", kind: "fact", title: "Kalia Santé's invoices go to their Lyon head office", body: "One invoice a month for all agencies, sent to accounting at the head office, purchase order number required.", entities: [c("Kalia Santé")] },
  { by: "sarah", zone: "sales", kind: "procedure", title: "Send a B2B quote from HubSpot", body: "Create the deal, add the fleet line items, generate the quote from the Encore template, send it from HubSpot so the opening is tracked.", entities: [t("HubSpot")] },
  { by: "sarah", zone: "sales", kind: "fact", title: "An average B2B deal: 85 phones, signed in 41 days", body: "Over the last 12 signatures. The longest one was the public sector, 4 months.", entities: [] },
  { by: "sarah", zone: "sales", kind: "task", title: "Book the booth for the 2027 mobility trade show", body: "Same corner as this year, near the entrance. Budget €14,000.", entities: [] },
  { by: "sarah", zone: "sales", kind: "fact", title: "Vallière's procurement requires 60-day payment terms", body: "Their purchasing policy, not negotiable; to factor into the cash forecast if they sign.", entities: [c("Groupe Vallière")] },
  { by: "sarah", zone: "sales", kind: "decision", title: "Schools get 15% off fleets above 30 phones", body: "To enter education; applies to the lease and to purchases.", entities: [pr("B2B leasing")] },
  // support
  { by: "sarah", zone: "support", kind: "procedure", title: "Replace a phone under warranty", body: "Individuals: prepaid label, new phone sent once the old one is scanned, about 5 days. Companies on a lease: replacement shipped first, within 48 hours.", entities: [pr("48-hour replacement")] },
  { by: "sarah", zone: "support", kind: "fact", title: "October's late deliveries came from the Lyon carrier strike", body: "Four days of strike at the carrier's hub; the backlog was cleared on October 14.", entities: [] },
  { by: "sarah", zone: "support", kind: "procedure", title: "Reset Face ID after a screen replacement", body: "Face ID needs the original sensor: if it fails after a screen swap, the phone goes back to the workshop, never to the customer.", entities: [pr("Diagnostics")] },
  { by: "sarah", zone: "support", kind: "fact", title: "Most eSIM tickets come from one carrier's customers", body: "Seven tickets out of ten: that carrier's app hides the QR code request three menus deep. A help article walks through it.", entities: [pr("eSIM"), t("Zendesk")] },
  { by: "sarah", zone: "support", kind: "task", title: "Translate the help center into Spanish", body: "Spain opens in the spring; start with the 20 most read articles.", entities: [t("Zendesk")] },
  { by: "sarah", zone: "support", kind: "procedure", title: "Refund a customer who paid in installments", body: "Refund from the Alma dashboard, not from Stripe: Alma cancels the remaining installments and refunds what was paid.", entities: [t("Alma")] },
  // finance
  { by: "jeanmarc", zone: "finance", kind: "fact", title: "Accessories are always sold at normal VAT", body: "Cases, chargers and screen protectors are new goods: 20% VAT on the full price, never on a margin.", entities: [t("Pennylane")] },
  { by: "jeanmarc", zone: "finance", kind: "procedure", title: "Pay the technicians' December overtime", body: "Hours validated by the workshop lead by the 20th, paid with the December payslip at 125% for the first 8 hours.", entities: [] },
  { by: "jeanmarc", zone: "finance", kind: "fact", title: "The buyers' Qonto cards are capped at €20,000 a month", body: "Raised to €35,000 in October and November for the Black Friday stock.", entities: [t("Qonto")] },
  { by: "jeanmarc", zone: "finance", kind: "decision", title: "Buybacks are paid by bank transfer within 48 hours", body: "Once the phone is tested at the workshop; no more vouchers.", entities: [pr("Trade-in")] },
  { by: "jeanmarc", zone: "finance", kind: "fact", title: "October's VAT is estimated at €41,000", body: "Higher than September with the first Black Friday preorders; to file before November 19.", entities: [t("Pennylane")] },
  { by: "jeanmarc", zone: "finance", kind: "fact", title: "Durand Accounting charges €1,800 a month", body: "Monthly statement, annual accounts and payroll included; the Series A data room is billed apart.", entities: [c("Durand Accounting")] },
  // leadership
  { by: "claire", zone: "leadership", kind: "decision", title: "The office move to Villeurbanne waits until 2027", body: "Not before the laptops: the workshop needs the space first.", entities: [] },
  { by: "claire", zone: "leadership", kind: "fact", title: "Who sits on the board", body: "Claire, our two investors and an independent member from the refurbishing industry.", entities: [] },
  { by: "claire", zone: "leadership", kind: "task", title: "Prepare the Series A data room", body: "Contracts, cap table, monthly figures since 2024 and the B2B pipeline, ready by February.", entities: [] },
  { by: "claire", zone: "leadership", kind: "fact", title: "2027 hiring plan: 6 technicians, 2 developers, 1 salesperson", body: "Most of it after the Series A; the technicians first, for the laptops in April.", entities: [pr("Laptops")] },
  // core
  { by: "claire", zone: "core", kind: "fact", title: CORPUS_MARKER, body: "12 rue de la Rize, Lyon. The office is open 9am to 7pm; the workshop next door keeps its own hours.", entities: [] },
  { by: "claire", zone: "core", kind: "procedure", title: "Book a meeting room", body: "The two rooms are booked in the shared calendar; the big one goes to customers first.", entities: [] },
  { by: "claire", zone: "core", kind: "fact", title: "Our suppliers: three wholesale buyers in Germany and Belgium", body: "They supply the B2B volumes; individuals' trade-ins cover the rest of the stock.", entities: [] },
]

/** Older versions of current decisions: `replacedBy` is part of the current item's title; search must never serve them. */
export const SUPERSEDED_ITEMS: (CorpusItem & { replacedBy: string })[] = [
  { by: "sarah", zone: "sales", kind: "decision", title: "First B2B lease: €23 per phone per month over 36 months", body: "Our first lease offer, buyback of the old fleet not included.", entities: [pr("B2B leasing")], replacedBy: "New B2B lease" },
  { by: "leo", zone: "dev", kind: "decision", title: "Léo sets the selling prices by hand every Monday", body: "One spreadsheet per model, updated on Mondays from the buyback prices.", entities: [pr("Pricing engine")], replacedBy: "Selling prices recomputed" },
  { by: "claire", zone: "leadership", kind: "decision", title: "Series A planned for January 2027", body: "We raise in January with the Q4 numbers.", entities: [], replacedBy: "Series A postponed" },
  { by: "leo", zone: "product", kind: "decision", title: "Returns goal: below 5% this quarter", body: "First returns goal, before the grading model.", entities: [pr("Returns")], replacedBy: "Priority of the quarter" },
]
