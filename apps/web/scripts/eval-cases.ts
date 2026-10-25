// Questions of the search evaluation (npm run eval), on the Encore demo company. A case expects one knowledge item,
// recognized by part of its title; several parts when more than one item answers the question. Write the question
// the way someone would ask it, never by copying the title: a case that only passes with the title's words measures
// nothing.

/** Demo people the access cases search as (the key of DEMO_USERS). */
export type DemoPerson = "claire" | "hugo" | "ines" | "jeanmarc" | "sarah" | "leo"

export type Case = { query: string; expect: string | string[] }

export type CaseSet = {
  name: string
  /** What the set measures, printed above its results. */
  about: string
  cases: Case[]
}

/** The first questions: phrasings slightly different from the titles (synonyms, a typo). */
const BASELINE: Case[] = [
  { query: "how do we deploy to production?", expect: "Deploy Encore to production" },
  { query: "how do we ship a release", expect: "Deploy Encore to production" },
  { query: "go live", expect: "Deploy Encore to production" },
  { query: "Qonto reconciliation", expect: "bank reconciliation" },
  { query: "bank reconcilation", expect: "bank reconciliation" },
  { query: "month-end close accountant export", expect: "Month-end close" },
  { query: "when to file VAT", expect: "VAT return" },
  { query: "VAT on second-hand phones", expect: "VAT margin scheme" },
  { query: "webhook charge.refunded", expect: "charge.refunded webhook" },
  { query: "restore a backup", expect: "Restore a Supabase backup" },
  { query: "backup restore staging", expect: "Restore a Supabase backup" },
  { query: "AI grading of the screen from photos", expect: "Screen grading" },
  { query: "scratches missed under the lights", expect: "hairline scratch" },
  { query: "how are selling prices set", expect: "Selling prices recomputed" },
  { query: "B2B lease price per phone", expect: "€19 per phone" },
  { query: "sales pipeline october", expect: "October B2B pipeline" },
  { query: "Groupe Vallière CSR report", expect: "Groupe Vallière" },
  { query: "eSIM won't transfer", expect: "Transfer a customer's eSIM" },
  { query: "battery health after a battery swap", expect: "battery was replaced" },
  { query: "burn and runway", expect: "Monthly burn" },
  { query: "phones sold goal for Christmas", expect: "7,500 phones" },
  { query: "returns not as described", expect: "under 3%" },
  { query: "trade in your old phone", expect: "trade-in" },
  { query: "refurbished macbooks", expect: "laptops" },
  { query: "hire someone to run the workshop", expect: "workshop lead" },
  { query: "Fleet & Mobility convention leads", expect: "40% of the year's B2B leads" },
]

/** The same needs in other words: almost nothing in common with the title, as a newcomer would ask. */
const PARAPHRASES: Case[] = [
  { query: "how do we push a new version of the shop", expect: "Deploy Encore to production" },
  { query: "bring the database back from last night's dump", expect: "Restore a Supabase backup" },
  { query: "which tax rule applies when we resell a handset bought from a private person", expect: "VAT margin scheme" },
  { query: "selling to a company in Brussels: what goes on the invoice", expect: "Belgian companies" },
  { query: "how many days before card payments reach our bank account", expect: "Stripe payouts land on Qonto" },
  { query: "how much money do we lose each month and how long can we last", expect: "Monthly burn" },
  { query: "when are we raising money", expect: "Series A postponed" },
  { query: "who handles salaries", expect: "Who to ask at Encore" },
  { query: "onboarding plan for a new hire", expect: "Your first week" },
  { query: "what is our business, in one sentence", expect: "What Encore does" },
  { query: "why do shoppers give up before paying", expect: "Customer interviews" },
  { query: "what makes buyers convert more than pictures", expect: "Customers choose on the battery" },
  { query: "how much of the helpdesk load does the bot absorb", expect: "Top 3 October tickets" },
  { query: "a client switched from Android to iPhone and lost their messages", expect: "WhatsApp chats lost" },
  { query: "screen flaws the camera missed under the bench lamp", expect: "hairline scratch" },
  { query: "monthly price per handset when a company rents a fleet", expect: "New B2B lease" },
  { query: "the home-care nursing company trial", expect: ["Kalia Santé: 40-phone pilot", "Follow up with Kalia Santé"] },
  { query: "the big customer that needs carbon reporting before signing", expect: ["Groupe Vallière considers", "Groupe Vallière (1,200 employees)"] },
  { query: "when do we stop changing prices before the November sales event", expect: "Black Friday prices freeze" },
  { query: "when do we start selling computers", expect: "No refurbished laptops before April" },
  { query: "who will run the benches when the team grows", expect: "Hire a workshop lead" },
  { query: "can I book a meeting with the technicians at 2pm", expect: "The workshop sets the pace" },
  { query: "how much did we sell over the summer", expect: "Q3 2026 revenue" },
  { query: "what the accountant needs from us every month", expect: "Month-end close" },
  { query: "matching bank lines with invoices every morning", expect: "bank reconciliation" },
  { query: "refund notification arrives before the parcel is back", expect: "charge.refunded" },
  { query: "automated browser tests for paying in installments", expect: "Playwright" },
  { query: "phones with a swapped battery show no percentage", expect: "Measure the battery health" },
  { query: "dents on the edges cause returns, should we photograph them", expect: "frame's corners" },
  { query: "who decides the price of each model", expect: "Selling prices recomputed" },
  { query: "the trade show that brings most business prospects", expect: "Fleet & Mobility convention brings" },
  { query: "share of orders where people send back their old device", expect: "30% of orders with a trade-in" },
  { query: "showing a prospect how the fleet product works", expect: "Prepare an Encore B2B demo" },
  { query: "what does the grade Fair mean", expect: "Encore words" },
  { query: "our values", expect: "Our three rules" },
  { query: "who buys from us", expect: "Our customers" },
  { query: "where do we want to be in 2028", expect: "Vision" },
  { query: "what is everyone focused on this quarter", expect: ["three priorities", "Q4 goal"] },
  { query: "deadline for the tax filing", expect: "File the September VAT return" },
  { query: "when is the next board meeting", expect: "Quarterly board" },
  { query: "which deals are being negotiated", expect: "October B2B pipeline" },
]

/** Typos, missing accents and half names, as typed in a hurry. */
const TYPOS: Case[] = [
  { query: "Kalia pilot", expect: "Kalia Santé: 40-phone pilot" },
  { query: "Valliere CSR report", expect: ["Groupe Vallière considers", "Groupe Vallière (1,200 employees)"] },
  { query: "pennylane month end export", expect: "Month-end close" },
  { query: "charge refunded webhok", expect: "charge.refunded" },
  { query: "esim tranfer", expect: "Transfer a customer's eSIM" },
  { query: "supabse backup restore", expect: "Restore a Supabase backup" },
  { query: "black friday freez", expect: "Black Friday prices freeze" },
  { query: "playwrite alma tests", expect: "Playwright" },
  { query: "qonto pennylane reconcile", expect: "bank reconciliation" },
  { query: "zendesk tickets octobre", expect: "Top 3 October tickets" },
  // A single misspelled word: nothing else to lean on.
  { query: "Valiere", expect: ["Groupe Vallière considers", "Groupe Vallière (1,200 employees)", "October B2B pipeline"] },
  { query: "playwrite", expect: "Playwright" },
]

/** Whole questions, the way an agent sends them in the middle of a task. */
const AGENT_QUESTIONS: Case[] = [
  { query: "I'm about to tag a release of the shop. What is our process and what should I watch afterwards?", expect: "Deploy Encore to production" },
  { query: "A Belgian company asks why their invoice has no reverse charge. What should I answer?", expect: "Belgian companies" },
  { query: "Kalia Santé wants broken phones replaced within 48 hours. What did we promise them and at what price?", expect: ["Kalia Santé: 40-phone pilot", "Follow up with Kalia Santé"] },
  { query: "I need to run the orders migration in production. Did anything go wrong with it on staging?", expect: "Staging migration 0042" },
  { query: "Can I deploy the shop at 10am on a Tuesday, or is there a rule against it?", expect: "The workshop sets the pace" },
  { query: "We want to equip 50 employees with phones. What is the cheapest option we offer?", expect: "New B2B lease" },
  { query: "A customer says their new phone loses battery fast right after setting it up. What do I tell them?", expect: ["Top 3 October tickets", "battery draining"] },
  { query: "Prepare the numbers for the board: what were revenue and margin last quarter?", expect: "Q3 2026 revenue" },
]

export const CASE_SETS: CaseSet[] = [
  { name: "baseline", about: "the first questions, close to the titles", cases: BASELINE },
  { name: "paraphrases", about: "other words than the title", cases: PARAPHRASES },
  { name: "typos", about: "typos, missing accents, half names", cases: TYPOS },
  { name: "agent questions", about: "whole questions in the middle of a task", cases: AGENT_QUESTIONS },
]

/**
 * Knowledge only the graph reaches: no word in common with the question, but the same customer, project or tool as
 * the best results (the B2B lease next to the Kalia Santé pilot, the price freeze next to a failing migration, the
 * backup restore next to the deployment). Expected among the 8 results of search_brain.
 */
export const GRAPH_CASES: Case[] = [
  { query: "Kalia Santé pilot", expect: "New B2B lease" },
  { query: "VAT return", expect: "bank reconciliation" },
  { query: "Groupe Vallière", expect: "Prepare an Encore B2B demo" },
  { query: "staging migration fails", expect: "Black Friday prices freeze" },
  { query: "how do we deploy", expect: "Restore a Supabase backup" },
]

/**
 * Searches as one person: nothing may come back from a zone they do not read (their own knowledge aside), graph
 * included. `expect`, when given: what they must still find in their own zones.
 */
export const ACCESS_CASES: (Partial<Case> & { as: DemoPerson; query: string })[] = [
  { as: "jeanmarc", query: "how do we deploy to production" },
  { as: "jeanmarc", query: "Kalia Santé lease price per phone" },
  { as: "jeanmarc", query: "daily bank reconciliation", expect: "bank reconciliation" },
  { as: "ines", query: "transfer a customer's eSIM" },
  { as: "sarah", query: "Q3 revenue and monthly burn" },
  { as: "sarah", query: "Kalia Santé pilot", expect: "Kalia Santé: 40-phone pilot" },
  { as: "hugo", query: "Series A fundraising after Christmas" },
  { as: "leo", query: "VAT margin scheme on buybacks" },
]
