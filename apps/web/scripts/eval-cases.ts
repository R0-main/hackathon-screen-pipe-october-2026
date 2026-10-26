// Questions of the search evaluation (npm run eval), on the Encore demo company. A case expects one knowledge item,
// recognized by part of its title; several parts when more than one item answers the question. Write the question
// the way someone would ask it, never by copying the title: a case that only passes with the title's words measures
// nothing.

/** Demo people the access cases search as (the key of DEMO_USERS). */
export type DemoPerson = "claire" | "hugo" | "ines" | "jeanmarc" | "sarah" | "leo"

export type Case = {
  query: string
  expect: string | string[]
  /** A tempting wrong item (part of its title): the question's words point to it. The case falls into the trap when it
   * comes before the expected item, or when only it comes back. */
  trap?: string
}

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

/** The words point to the wrong item: only the meaning tells them apart. */
const TRAPS: Case[] = [
  { query: "the price we promised Kalia Santé per phone", expect: "Kalia Santé: 40-phone pilot", trap: "New B2B lease" },
  { query: "price of our standard B2B lease", expect: "New B2B lease", trap: "Kalia Santé: 40-phone pilot" },
  { query: "what is the VAT deadline", expect: "File the September VAT return", trap: "VAT margin scheme" },
  { query: "why do we show the battery percentage on product pages", expect: "Customers choose on the battery", trap: "Measure the battery health" },
  { query: "Stripe event fires before the return is scanned at the workshop", expect: "charge.refunded", trap: "Stripe payouts land" },
  { query: "the workshop app gives no battery reading after a swap", expect: "Measure the battery health", trap: "The workshop sets the pace" },
  { query: "when does Alma's money reach Qonto", expect: "Stripe payouts land on Qonto", trap: "bank reconciliation" },
  { query: "eSIM problems among this month's support tickets", expect: "Top 3 October tickets", trap: "Transfer a customer's eSIM" },
  { query: "a Supabase migration of the orders table that times out", expect: "Staging migration 0042", trap: "Restore a Supabase backup" },
  { query: "the Groupe Vallière demo on November 5", expect: "Groupe Vallière (1,200 employees)", trap: "Prepare an Encore B2B demo" },
  { query: "do laptops change the grading rules", expect: "No refurbished laptops before April", trap: "Screen grading" },
  { query: "the WhatsApp history lost when moving to a new phone", expect: "WhatsApp chats lost", trap: "Transfer a customer's eSIM" },
  // Harder: the wrong item shares more words with the question than the right one.
  { query: "how do we restore the shop if a production deploy breaks", expect: "Deploy Encore to production", trap: "Restore a Supabase backup" },
  { query: "battery health shown on the product page lifts sales", expect: "Customers choose on the battery", trap: "Measure the battery health" },
  { query: "the return rate we present to the board", expect: "Quarterly board", trap: "Priority of the quarter" },
  { query: "reconciling Stripe and Alma payouts every morning", expect: "bank reconciliation", trap: "Stripe payouts land on Qonto" },
  { query: "spec of the CO₂ and e-waste report", expect: "Write the spec of the automatic CSR report", trap: "Groupe Vallière considers" },
  { query: "customers afraid of losing their data when they transfer to a new phone", expect: "Customer interviews", trap: "Transfer a customer's eSIM" },
  { query: "what do the grades Excellent, Very good and Fair mean", expect: "Encore words", trap: "Screen grading" },
  { query: "someone to own grading quality at the workshop", expect: "Hire a workshop lead", trap: "Screen grading" },
  { query: "VAT on phones sold to Belgian companies", expect: "Belgian companies", trap: "VAT margin scheme" },
]

/** The answer is a number, a date or a detail inside the text, not in the title. */
const FIGURES: Case[] = [
  { query: "how much does each return cost us", expect: "Priority of the quarter" },
  { query: "how big is the Groupe Vallière deal in euros", expect: "Groupe Vallière (1,200 employees)" },
  { query: "what is our gross margin", expect: ["Key figures", "Q3 2026 revenue"] },
  { query: "how many technicians work at the workshop", expect: ["The workshop sets the pace", "Hire a workshop lead"] },
  { query: "how much VAT do we expect to pay for September", expect: "File the September VAT return" },
  { query: "what happens on November 17", expect: "Black Friday prices freeze" },
  { query: "what is planned on November 5", expect: "Groupe Vallière (1,200 employees)" },
  { query: "what must be done before December 15", expect: "Fleet & Mobility convention brings" },
  { query: "when did the board approve postponing the raise", expect: "Series A postponed" },
  { query: "how much money is tied up in phone stock", expect: "Monthly burn" },
  { query: "what share of tickets does the AI answer on its own", expect: "Top 3 October tickets" },
  { query: "the minimum battery health we guarantee", expect: "Customers choose on the battery" },
  { query: "how many iPhones do we buy for Black Friday", expect: "Black Friday prices freeze" },
  { query: "what does a buyback record keep for the tax office", expect: "VAT margin scheme" },
]

/** Who does what: the answer names a person or a partner, often in the text only. */
const PEOPLE: Case[] = [
  { query: "who is our accountant", expect: "Month-end close" },
  { query: "who validates a price outside the usual band", expect: "Selling prices recomputed" },
  { query: "who checks the CSR report before it is sent", expect: "Write the spec of the automatic CSR report" },
  { query: "who decides on the Groupe Vallière side", expect: "Groupe Vallière (1,200 employees)" },
  { query: "who prepares the financials for the board", expect: "Quarterly board" },
  { query: "who should I ask about the workshop app", expect: "Who to ask at Encore" },
  { query: "who was in the meeting that froze prices", expect: "Black Friday prices freeze" },
]

/** Asked in French, as the team does: the knowledge is written in English. */
const FRENCH: Case[] = [
  { query: "comment on déploie en production", expect: "Deploy Encore to production" },
  { query: "restaurer une sauvegarde de la base", expect: "Restore a Supabase backup" },
  { query: "TVA sur les téléphones rachetés à des particuliers", expect: "VAT margin scheme" },
  { query: "quand est-ce qu'on lève des fonds", expect: "Series A postponed" },
  { query: "combien nous coûte un retour", expect: "Priority of the quarter" },
  { query: "rapprochement bancaire quotidien", expect: "bank reconciliation" },
  { query: "transférer l'eSIM d'un client", expect: "Transfer a customer's eSIM" },
  { query: "le prix du leasing pour les entreprises", expect: "New B2B lease" },
  { query: "qui contacter pour la paie", expect: "Who to ask at Encore" },
  { query: "objectif de ventes pour Noël", expect: "Q4 goal" },
  { query: "pourquoi les clients abandonnent leur panier", expect: "Customer interviews" },
  { query: "les horaires de l'atelier", expect: "The workshop sets the pace" },
]

export const CASE_SETS: CaseSet[] = [
  { name: "baseline", about: "the first questions, close to the titles", cases: BASELINE },
  { name: "paraphrases", about: "other words than the title", cases: PARAPHRASES },
  { name: "typos", about: "typos, missing accents, half names", cases: TYPOS },
  { name: "agent questions", about: "whole questions in the middle of a task", cases: AGENT_QUESTIONS },
  { name: "traps", about: "the words point to the wrong item", cases: TRAPS },
  { name: "figures & dates", about: "the answer is inside the text", cases: FIGURES },
  { name: "people", about: "who does what", cases: PEOPLE },
  { name: "french", about: "asked in French, written in English", cases: FRENCH },
]

/**
 * Nothing in the brain answers these: the best search says so (no result) rather than serving whatever shares a word.
 * Measured, not counted in the scores: answering nothing is a trade-off with finding the rest.
 */
export const UNANSWERABLE: string[] = [
  "what is our parental leave policy",
  "how do we handle GDPR data deletion requests",
  "who is our insurance provider",
  "what is the wifi password at the office",
  "how many vacation days do employees get",
  "do we ship to Canada",
  "how is our Kubernetes cluster set up",
  "what did we sign with Tesla",
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
  { as: "leo", query: "monthly burn and runway" },
  { as: "hugo", query: "how much VAT for September" },
  { as: "hugo", query: "transfer a customer's eSIM", expect: "Transfer a customer's eSIM" },
  { as: "sarah", query: "staging migration that times out" },
  { as: "sarah", query: "Series A postponed to April" },
  { as: "ines", query: "WhatsApp chats lost after switching phones" },
  { as: "ines", query: "how do we deploy to production", expect: "Deploy Encore to production" },
  { as: "jeanmarc", query: "how big is the Groupe Vallière deal" },
]
