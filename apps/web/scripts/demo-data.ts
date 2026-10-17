// Fictional company for the demo: Butine, connected scales for beehives and a monitoring app for beekeepers.

import type { Entity, KnowledgeKind, Role, SkillFile } from "@brain/core"

export const DEMO_ORG = {
  name: "Butine",
  description:
    "Butine makes connected scales for beehives: slipped under the hive, the scale tells the beekeeper, on their phone, whether their bees are doing well (harvest, swarming, cold, theft), without opening the hive. 3,200 hives equipped at 140 beekeepers, 6 people, based in Lyon.",
}

/** The demo company's former name: a demo brain still on it is replaced once by the current demo. */
export const LEGACY_DEMO_NAMES = ["Fournil"]

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
  { key: "claire", name: "Claire Martin", title: "CEO", role: "admin", zones: [], email: "claire@butine.example" },
  { key: "hugo", name: "Hugo Bernard", title: "Lead dev", role: "member", zones: ["dev", "product", "support"], email: "hugo@butine.example", manager: "claire", publishSkills: true },
  { key: "ines", name: "Inès Lefèvre", title: "Full-stack developer", role: "member", zones: ["dev", "product"], email: "ines@butine.example", manager: "hugo" },
  { key: "jeanmarc", name: "Jean-Marc Dubois", title: "Finance lead", role: "member", zones: ["finance"], email: "jean-marc@butine.example", manager: "claire", publishSkills: true },
  { key: "sarah", name: "Sarah Cohen", title: "Head of Sales", role: "member", zones: ["sales", "support", "product"], email: "sarah@butine.example", manager: "claire" },
  { key: "leo", name: "Léo Petit", title: "Product manager", role: "member", zones: ["product", "dev", "support", "sales"], email: "leo@butine.example", manager: "claire" },
]

export type DemoItem = {
  author: string
  zone: string
  kind: KnowledgeKind
  title: string
  body: string
  entities: Entity[]
  daysAgo: number
  tool?: "claude-code" | "codex" | "chatgpt" | "claude"
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
    title: "Subscriptions move from Stripe Checkout to Stripe Billing",
    body: "Stripe Billing handles per-hive billing (the quantity changes as soon as a beekeeper adds a scale), free trials and the yearly billing requested by cooperatives. Checkout stays for selling the scales. Decided with Léo.",
    entities: [t("Stripe"), p("Léo Petit"), pr("Subscriptions")],
  },
  {
    author: "hugo", zone: "dev", kind: "procedure", daysAgo: 8, tool: "claude-code",
    title: "Deploy Butine to production",
    body: "1. Merge into main through an approved PR.\n2. GitHub Actions CI runs the tests and applies the Supabase migrations on staging.\n3. Create the vX.Y.Z tag: Vercel deploys the API and the web app.\n4. Watch Sentry for 15 minutes; roll back by promoting the previous release on Vercel.\nThe scales' firmware never ships with this tag: it has its own over-the-air update, in batches of 5%.",
    entities: [t("GitHub"), t("Supabase"), t("Vercel"), t("Sentry")],
  },
  {
    author: "ines", zone: "dev", kind: "fact", daysAgo: 7, tool: "claude-code",
    title: "The scales drift by 300 g per frosty night",
    body: "The load cell contracts below 0 °C: without a correction, the app saw the hives lose weight every winter night. Temperature compensation in place in the measurements service (measurements/cold-compensation.ts).",
    entities: [pr("B2 scale"), pr("Measurements")],
  },
  {
    author: "hugo", zone: "dev", kind: "decision", daysAgo: 6, tool: "claude-code",
    title: "Beekeepers isolated with Supabase RLS rather than separate schemas",
    body: "Every business table carries a beekeeper_id and RLS policies. One schema per customer would have made migrations harder for 140 beekeepers.",
    entities: [t("Supabase"), t("Postgres")],
  },
  {
    author: "ines", zone: "dev", kind: "task", daysAgo: 3, tool: "claude-code",
    title: "Fix the false swarm alerts during the harvest",
    body: "Removing a full super drops the weight by 15 kg at once: the algorithm sees a swarm leaving. Ignore the drops when the beekeeper has logged a visit.",
    entities: [pr("Swarm alert"), pr("Measurements")],
  },
  {
    author: "ines", zone: "dev", kind: "task", daysAgo: 5, tool: "claude-code", done: true,
    title: "Add Playwright e2e tests on installing a scale",
    body: "Covers pairing, picking the apiary and the first weighing shown in the app.",
    entities: [t("Playwright"), pr("B2 scale")],
  },
  {
    author: "hugo", zone: "dev", kind: "fact", daysAgo: 4, tool: "codex",
    title: "The Stripe invoice.paid webhook can arrive before the customer is created",
    body: "The handler is made idempotent (key = event.id) and retries three times with backoff if the customer does not exist yet.",
    entities: [t("Stripe"), pr("Subscriptions")],
  },
  {
    author: "hugo", zone: "dev", kind: "procedure", daysAgo: 2, tool: "claude-code",
    title: "Restore a Supabase backup on staging",
    body: "1. Download the daily backup from the Supabase dashboard.\n2. supabase db reset --linked on staging.\n3. Restore with pg_restore --no-owner.\n4. Rerun the missing migrations then check the number of hives.",
    entities: [t("Supabase"), t("Postgres")],
  },
  {
    author: "ines", zone: "dev", kind: "question", daysAgo: 1, tool: "claude-code",
    title: "Should the scale keep its weighings when the LoRa network goes down?",
    body: "Mountain apiaries lose the network for whole days: that is half of the \"silent scale\" tickets. A 7-day buffer would solve it but needs a new firmware (~3 weeks).",
    entities: [pr("B2 scale"), t("LoRaWAN")],
  },
  // --- Product ---
  {
    author: "leo", zone: "product", kind: "decision", daysAgo: 9, tool: "claude",
    title: "Priority of the quarter: the swarm alert",
    body: "Q4 goal: warn the beekeeper within the hour when a colony swarms (sudden weight drop, rising buzz). It is the number one request from the beekeepers we interviewed: a lost swarm is half of the hive's harvest.",
    entities: [pr("Swarm alert")],
  },
  {
    author: "leo", zone: "product", kind: "fact", daysAgo: 8, tool: "claude",
    title: "Beekeepers open the app at the apiary, gloves on",
    body: "Hence the very big buttons, maximum contrast in full sun and no keyboard input on the visit screen.",
    entities: [pr("Butine app")],
  },
  {
    author: "sarah", zone: "product", kind: "fact", daysAgo: 6, tool: "chatgpt",
    title: "Miellerie Roussel considers exporting weighings to Excel essential",
    body: "Their technician tracks the honey flow hive by hive in Excel every week. Without an export, no signature.",
    entities: [c("Miellerie Roussel"), t("Excel")],
  },
  {
    author: "leo", zone: "product", kind: "task", daysAgo: 4, tool: "claude",
    title: "Write the spec of the swarm alert",
    body: "Weight drop thresholds, confirmation by sound, push and SMS notification, an \"I'm at the apiary\" mode that mutes the alerts during the visit.",
    entities: [pr("Swarm alert")],
  },
  {
    author: "leo", zone: "product", kind: "decision", daysAgo: 3, tool: "claude",
    title: "No Asian hornet detection in the first version",
    body: "We ship the swarm alert first; hornet detection by sound comes in March, with Miellerie Roussel as the pilot customer.",
    entities: [pr("Swarm alert"), pr("Hornet detection"), c("Miellerie Roussel")],
  },
  {
    author: "leo", zone: "product", kind: "fact", daysAgo: 2, tool: "claude",
    title: "Product goal: 50% of beekeepers with the swarm alert turned on by the end of December",
    body: "Measured as at least one hive tracked with the alert on. Tracked in the product dashboard.",
    entities: [pr("Swarm alert")],
  },
  // --- Sales ---
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 7, tool: "chatgpt",
    title: "Miellerie Roussel (900 hives) ready to sign if the weighing export ships in November",
    body: "Yearly contract estimated at €35,000. Decision maker: the manager. Next step: export demo on November 5.",
    entities: [c("Miellerie Roussel")],
  },
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 5, tool: "claude",
    title: "October pipeline: 22 prospects, 7 demos scheduled, 3 negotiations",
    body: "The three negotiations: Miellerie Roussel, Hôtels Céleste and Coop'Apis Provence. Demo → signature conversion rate of 35% over the quarter.",
    entities: [c("Miellerie Roussel"), c("Hôtels Céleste"), c("Coop'Apis Provence"), t("HubSpot")],
  },
  {
    author: "claire", zone: "sales", kind: "decision", daysAgo: 6, tool: "claude",
    title: "New price: €4 per hive per month, -20% yearly",
    body: "The scale is still sold at €149. In line with direct competitors and compatible with the MRR goal. Existing customers keep their price until June.",
    entities: [pr("Subscriptions")],
  },
  {
    author: "sarah", zone: "sales", kind: "procedure", daysAgo: 4, tool: "claude",
    title: "Prepare a Butine demo",
    body: "1. Create a demo apiary from the admin (\"Demo\" button).\n2. Load a template season (acacia honey flow, swarming in May, wintering).\n3. Show the weight curve, the alert for a hive getting lighter, then the weighing export.\n4. End on the swarm alert (Figma mockups until the module ships).",
    entities: [t("Figma"), pr("Swarm alert")],
  },
  {
    author: "sarah", zone: "sales", kind: "task", daysAgo: 2, tool: "claude",
    title: "Follow up with Hôtels Céleste after the Miel & Ruches convention",
    body: "They want to show their guests the 24 hives set on the roofs of their hotels. Send the proposal before Friday.",
    entities: [c("Hôtels Céleste"), pr("Corporate hives")],
  },
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 1, tool: "chatgpt",
    title: "The Miel & Ruches convention brings 40% of the year's leads",
    body: "Budget the 2027 booth from January; register before December 15 for the discounted rate.",
    entities: [],
  },
  // --- Finance ---
  {
    author: "jeanmarc", zone: "finance", kind: "procedure", daysAgo: 9, tool: "claude",
    title: "Daily Qonto ↔ Pennylane bank reconciliation",
    body: "1. Export yesterday's Qonto transactions.\n2. Match them with the invoices and Stripe payouts in Pennylane.\n3. List the variances (payment without an invoice, invoice unpaid at D+30).\n4. Send the variances to Sarah for customer follow-ups.",
    entities: [t("Qonto"), t("Pennylane"), t("Stripe"), p("Sarah Cohen")],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "fact", daysAgo: 8, tool: "claude",
    title: "Month-end close: Pennylane export before the 5th for Durand Accounting",
    body: "The accountant (Durand Accounting) produces the monthly statement within 10 days from that export.",
    entities: [t("Pennylane"), c("Durand Accounting")],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "decision", daysAgo: 6, tool: "claude",
    title: "Expense reports go through Swile from November",
    body: "No more spreadsheets, trips to the apiaries included: every expense is photographed in Swile and synced with Pennylane.",
    entities: [t("Swile"), t("Pennylane")],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "fact", daysAgo: 5, tool: "claude",
    title: "Monthly burn of about €48k, 14 months of runway as of October 1",
    body: "Excluding fundraising. Beekeepers buy their scales between January and March: cash dips in winter and comes back up in spring.",
    entities: [],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "task", daysAgo: 3, tool: "claude",
    title: "File the September VAT return before October 19",
    body: "Estimated amount: €6,900. Check the reverse charge on importing the scales' circuit boards.",
    entities: [pr("B2 scale")],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "fact", daysAgo: 2, tool: "claude",
    title: "Stripe payouts land on Qonto at D+7",
    body: "To take into account in the cash forecast and in the daily reconciliation.",
    entities: [t("Stripe"), t("Qonto")],
  },
  // --- Support ---
  {
    author: "hugo", zone: "support", kind: "procedure", daysAgo: 7, tool: "claude-code",
    title: "Wake up a scale that no longer sends weighings",
    body: "1. In the app, check the last weighing and the battery level.\n2. Battery under 10%: change the batteries (lithium, never alkaline: they give out in the cold).\n3. Otherwise, press under the scale for 5 seconds until it blinks blue: it joins the LoRa network.\n4. Wait for a weighing (15 minutes). Still nothing: open a \"hardware\" ticket with the serial number.",
    entities: [pr("B2 scale"), t("LoRaWAN")],
  },
  {
    author: "leo", zone: "support", kind: "fact", daysAgo: 4, tool: "claude",
    title: "Top 3 October tickets: silent scale, false alerts, Excel export",
    body: "58 tickets in total, 22 of them about scales that no longer send anything (LoRa network in the mountains). The buffer and the Excel export would remove half of the volume.",
    entities: [t("Excel"), pr("B2 scale")],
  },
  {
    author: "sarah", zone: "support", kind: "task", daysAgo: 1, tool: "claude",
    title: "Write the FAQ on apiaries without network",
    body: "Explain what happens when the apiary loses the LoRa network, and how to set up a relay antenna at the edge of the apiary.",
    entities: [t("LoRaWAN")],
  },
  // --- Leadership ---
  {
    author: "claire", zone: "leadership", kind: "fact", daysAgo: 9, tool: "claude",
    title: "Q4 goal: 4,500 hives equipped and €20k MRR",
    body: "We are at 3,200 hives at 140 beekeepers and €13.4k MRR as of October 1. The swarm alert and Miellerie Roussel are the two main levers.",
    entities: [c("Miellerie Roussel"), pr("Swarm alert")],
  },
  {
    author: "claire", zone: "leadership", kind: "decision", daysAgo: 7, tool: "claude",
    title: "Seed round postponed to April 2027: we raise after the ordering season",
    body: "Beekeepers equip their hives between January and March: with 14 months of runway, we would rather raise with the spring numbers. The board approved it on October 2.",
    entities: [],
  },
  {
    author: "claire", zone: "leadership", kind: "task", daysAgo: 4, tool: "claude",
    title: "Hire an embedded engineer by January",
    body: "For the buffer firmware, then hornet detection by sound. Job description to validate with Hugo.",
    entities: [p("Hugo Bernard"), pr("Hornet detection")],
  },
  {
    author: "claire", zone: "leadership", kind: "fact", daysAgo: 1, tool: "claude",
    title: "Quarterly board on November 12: MRR, churn and active hives KPIs",
    body: "Jean-Marc prepares the financials, Léo the swarm alert adoption.",
    entities: [p("Jean-Marc Dubois"), p("Léo Petit")],
  },
]

/** Typical prompts per zone, for the history and the simulator. */
export const DEMO_PROMPTS: Record<string, { user: string; text: string }[]> = {
  dev: [
    { user: "hugo", text: "Why is the Stripe invoice.paid webhook failing in prod this morning?" },
    { user: "ines", text: "Fix the false swarm alerts when the beekeeper removes a super" },
    { user: "hugo", text: "Prepare the Supabase migration for the alerts table" },
    { user: "ines", text: "Write the Playwright tests for pairing a scale" },
  ],
  product: [
    { user: "leo", text: "Write the spec of the swarm alert's \"I'm at the apiary\" mode" },
    { user: "leo", text: "Summarize the beekeepers' feedback on the visit screen" },
  ],
  sales: [
    { user: "sarah", text: "Prepare a yearly proposal for Hôtels Céleste's rooftop hives" },
    { user: "sarah", text: "Summarize the pipeline and the deals in negotiation this week" },
  ],
  finance: [
    { user: "jeanmarc", text: "Prepare the September VAT return from Pennylane" },
    { user: "jeanmarc", text: "Update the cash forecast with the Stripe payouts" },
  ],
  support: [
    { user: "hugo", text: "Why is the scale of hive 12 at the Die apiary no longer sending anything?" },
    { user: "sarah", text: "Write the answer to the ticket about the Excel weighing export" },
  ],
  leadership: [
    { user: "claire", text: "Prepare the MRR and churn KPIs for the November 12 board" },
    { user: "claire", text: "Where do we stand on the quarter's goals?" },
  ],
}

/** The prompt Jean-Marc runs every morning around 9am: the demo's automation suggestion. */
export const JEANMARC_DAILY_PROMPT = "Reconcile yesterday's Qonto statements with the Pennylane invoices and list the variances"

/** Butine's skills: `zone` is the cortex that receives them (null: the whole company). */
export type DemoSkill = { author: string; name: string; description: string; zone: string | null; daysAgo: number; version?: number; files: SkillFile[] }

export const DEMO_SKILLS: DemoSkill[] = [
  {
    author: "claire", name: "butine-tone", zone: null, daysAgo: 9,
    description: "Write an email, a post or a customer reply in Butine's tone. Use it for any text meant for a beekeeper.",
    files: [
      {
        path: "SKILL.md",
        content: `# Butine's tone

Our customers are beekeepers: they read us at the apiary, gloves on, often in full sun.

- Short sentences, one message = one idea, polite and warm.
- Talk about their trade (colonies, honey flow, supers, visit), never about a "solution" or a "platform".
- No emoji, no exclamation mark.
- End with a clear action and a date when there is one.
- Sign with the person's first name, followed by "the Butine team".
`,
      },
    ],
  },
  {
    author: "hugo", name: "deploy-butine", zone: "dev", daysAgo: 8, version: 3,
    description: "Deploy Butine to production (tag, Vercel, Sentry watch) and roll back if needed.",
    files: [
      {
        path: "SKILL.md",
        content: `# Deploy Butine to production

1. Check that main is green: \`gh run list --branch main --limit 1\`.
2. Run \`scripts/release.sh <version>\`: it creates the vX.Y.Z tag, Vercel deploys the API and the web app.
3. Watch Sentry for 15 minutes (\`scripts/release.sh --watch\`).
4. If there is a new error: promote the previous release on Vercel, then tell #dev.

Supabase migrations are applied by CI on staging before the tag: never run them by hand in prod.
The scales' firmware never ships with this tag: it has its own over-the-air update, in batches of 5%.
`,
      },
      {
        path: "scripts/release.sh",
        content: `#!/usr/bin/env bash
# Creates the release tag (Vercel deploys prod on the tag), or watches Sentry with --watch.
set -euo pipefail

if [[ "\${1:-}" == "--watch" ]]; then
  echo "New Sentry errors in the last 15 minutes:"
  sentry-cli issues list --project butine-api --query "firstSeen:-15m" --status unresolved
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
2. Review the variances: payment without an invoice, invoice unpaid at D+30, incomplete Stripe payout.
3. Send the list of invoices to follow up to Sarah (sales).

Stripe payouts land on Qonto at D+7: a Stripe variance under 7 days old is not one.
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
    description: "Prepare the Butine demo for a prospect: demo apiary, template season, a 20-minute run-through.",
    files: [
      {
        path: "SKILL.md",
        content: `# Prepare a customer demo

1. Create a demo apiary from the admin ("Demo" button), named after the prospect.
2. Load a template season (acacia honey flow, swarming in May, wintering).
3. Run-through: a hive's weight curve, the alert for a hive getting lighter, the weighing export, then the swarm alert.
4. Record in the brain what the prospect asked for (Sales zone), with the next step and its date.
`,
      },
    ],
  },
  {
    author: "hugo", name: "fix-scale", zone: "support", daysAgo: 3,
    description: "Guide a beekeeper whose scale no longer sends weighings.",
    files: [
      {
        path: "SKILL.md",
        content: `# Fix a silent scale

1. In the app, check the last weighing and the battery level.
2. Battery under 10%: change the batteries (lithium, never alkaline: they give out in the cold).
3. Otherwise, press under the scale for 5 seconds until it blinks blue: it joins the LoRa network.
4. Wait for a weighing (15 minutes). Still nothing: open a "hardware" ticket with the serial number.
`,
      },
    ],
  },
]
