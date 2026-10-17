// Fictional company for the demo: Fournil, management software for artisan bakeries.

import type { Entity, KnowledgeKind, Role, SkillFile } from "@brain/core"

export const DEMO_ORG = {
  name: "Fournil",
  description:
    "Fournil makes point-of-sale, inventory and preorder software for artisan bakeries. 85 bakery customers, 6 people, based in Paris.",
}

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
  { key: "claire", name: "Claire Martin", title: "CEO", role: "admin", zones: [], email: "claire@fournil.example" },
  { key: "hugo", name: "Hugo Bernard", title: "Lead dev", role: "member", zones: ["dev", "product", "support"], email: "hugo@fournil.example", manager: "claire", publishSkills: true },
  { key: "ines", name: "Inès Lefèvre", title: "Full-stack developer", role: "member", zones: ["dev", "product"], email: "ines@fournil.example", manager: "hugo" },
  { key: "jeanmarc", name: "Jean-Marc Dubois", title: "Finance lead", role: "member", zones: ["finance"], email: "jean-marc@fournil.example", manager: "claire", publishSkills: true },
  { key: "sarah", name: "Sarah Cohen", title: "Head of Sales", role: "member", zones: ["sales", "support", "product"], email: "sarah@fournil.example", manager: "claire" },
  { key: "leo", name: "Léo Petit", title: "Product manager", role: "member", zones: ["product", "dev", "support", "sales"], email: "leo@fournil.example", manager: "claire" },
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
    body: "Stripe Billing handles proration, free trials and the yearly billing requested by multi-shop customers. Checkout stays for one-off purchases (hardware). Decided with Léo.",
    entities: [t("Stripe"), p("Léo Petit"), pr("Subscriptions")],
  },
  {
    author: "hugo", zone: "dev", kind: "procedure", daysAgo: 8, tool: "claude-code",
    title: "Deploy Fournil to production",
    body: "1. Merge into main through an approved PR.\n2. GitHub Actions CI runs the tests and applies the Supabase migrations on staging.\n3. Create the vX.Y.Z tag: Vercel deploys prod.\n4. Watch Sentry for 15 minutes; roll back by promoting the previous release on Vercel.",
    entities: [t("GitHub"), t("Supabase"), t("Vercel"), t("Sentry")],
  },
  {
    author: "ines", zone: "dev", kind: "fact", daysAgo: 7, tool: "claude-code",
    title: "SumUp terminals disconnect after 30 min of inactivity",
    body: "The SumUp SDK drops the Bluetooth session after 30 minutes. Workaround in place: a keepalive every 10 minutes in the POS service (pos/sumup-keepalive.ts).",
    entities: [t("SumUp"), pr("POS")],
  },
  {
    author: "hugo", zone: "dev", kind: "decision", daysAgo: 6, tool: "claude-code",
    title: "Bakeries isolated with Supabase RLS rather than separate schemas",
    body: "Every business table carries a bakery_id and RLS policies. One schema per customer would have made migrations harder for 85 bakeries.",
    entities: [t("Supabase"), t("Postgres")],
  },
  {
    author: "ines", zone: "dev", kind: "task", daysAgo: 3, tool: "claude-code",
    title: "Fix the negative stock computation on pastries",
    body: "Unsold returns are counted twice when the shop closes the day offline.",
    entities: [pr("Inventory")],
  },
  {
    author: "ines", zone: "dev", kind: "task", daysAgo: 5, tool: "claude-code", done: true,
    title: "Add Playwright e2e tests on the ordering flow",
    body: "Covers order creation, payment and receipt printing.",
    entities: [t("Playwright"), pr("Preorders")],
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
    body: "1. Download the daily backup from the Supabase dashboard.\n2. supabase db reset --linked on staging.\n3. Restore with pg_restore --no-owner.\n4. Rerun the missing migrations then check the number of bakeries.",
    entities: [t("Supabase"), t("Postgres")],
  },
  {
    author: "ines", zone: "dev", kind: "question", daysAgo: 1, tool: "claude-code",
    title: "Should the POS app go offline-first (PWA)?",
    body: "Morning network outages cause half of the sync tickets. A PWA with a local queue would solve it but takes ~3 weeks.",
    entities: [pr("POS")],
  },
  // --- Product ---
  {
    author: "leo", zone: "product", kind: "decision", daysAgo: 9, tool: "claude",
    title: "Priority of the quarter: the online preorder module",
    body: "Q4 goal: let bakery customers preorder the weekend's bread and cakes. It is the number one request from the bakers we interviewed.",
    entities: [pr("Preorders")],
  },
  {
    author: "leo", zone: "product", kind: "fact", daysAgo: 8, tool: "claude",
    title: "Bakers mostly use the app between 5am and 7am",
    body: "Hence dark mode by default, big buttons and no keyboard input on the batch screen.",
    entities: [pr("POS")],
  },
  {
    author: "sarah", zone: "product", kind: "fact", daysAgo: 6, tool: "chatgpt",
    title: "La Mie Dorée considers exporting sales to Excel essential",
    body: "Their accountant reworks sales per shop in Excel every week. Without an export, no signature.",
    entities: [c("La Mie Dorée"), t("Excel")],
  },
  {
    author: "leo", zone: "product", kind: "task", daysAgo: 4, tool: "claude",
    title: "Write the spec of the preorder module",
    body: "Customer journey, pickup slots, optional online payment, SMS notifications.",
    entities: [pr("Preorders")],
  },
  {
    author: "leo", zone: "product", kind: "decision", daysAgo: 3, tool: "claude",
    title: "No multi-shop support in the first version of preorders",
    body: "We ship for a single shop first; multi-shop comes in January with La Mie Dorée as the pilot customer.",
    entities: [pr("Preorders"), c("La Mie Dorée")],
  },
  {
    author: "leo", zone: "product", kind: "fact", daysAgo: 2, tool: "claude",
    title: "Product goal: 40% of bakeries active on preorders by the end of December",
    body: "Measured as at least one preorder per week. Tracked in the product dashboard.",
    entities: [pr("Preorders")],
  },
  // --- Sales ---
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 7, tool: "chatgpt",
    title: "La Mie Dorée (12 shops) ready to sign if the accounting export ships in November",
    body: "Contract estimated at €7,000/year. Decision maker: the CFO. Next step: export demo on November 5.",
    entities: [c("La Mie Dorée")],
  },
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 5, tool: "claude",
    title: "October pipeline: 18 prospects, 6 demos scheduled, 3 negotiations",
    body: "The three negotiations: La Mie Dorée, Maison Kayser Lyon and Au Pain d'Antan. Demo → signature conversion rate of 35% over the quarter.",
    entities: [c("La Mie Dorée"), c("Maison Kayser Lyon"), c("Au Pain d'Antan"), t("HubSpot")],
  },
  {
    author: "claire", zone: "sales", kind: "decision", daysAgo: 6, tool: "claude",
    title: "New price: €49 per month per shop, -20% yearly",
    body: "In line with direct competitors and compatible with the MRR goal. Existing customers keep their price until June.",
    entities: [pr("Subscriptions")],
  },
  {
    author: "sarah", zone: "sales", kind: "procedure", daysAgo: 4, tool: "claude",
    title: "Prepare a Fournil demo",
    body: "1. Create a demo bakery from the admin (\"Demo\" button).\n2. Import the template catalog (breads, pastries, cakes).\n3. Show the morning batch, the POS, then the sales export.\n4. End on preorders (Figma mockups until the module ships).",
    entities: [t("Figma"), pr("Preorders")],
  },
  {
    author: "sarah", zone: "sales", kind: "task", daysAgo: 2, tool: "claude",
    title: "Follow up with Maison Kayser Lyon after the Europain trade show",
    body: "They were waiting for the new yearly pricing. Send the proposal before Friday.",
    entities: [c("Maison Kayser Lyon")],
  },
  {
    author: "sarah", zone: "sales", kind: "fact", daysAgo: 1, tool: "chatgpt",
    title: "The Europain trade show brings 40% of the year's leads",
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
    body: "No more spreadsheets: every expense is photographed in Swile and synced with Pennylane.",
    entities: [t("Swile"), t("Pennylane")],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "fact", daysAgo: 5, tool: "claude",
    title: "Monthly burn of about €62k, 14 months of runway as of October 1",
    body: "Excluding fundraising. Moving to yearly pricing would improve working capital from the first quarter of 2027.",
    entities: [],
  },
  {
    author: "jeanmarc", zone: "finance", kind: "task", daysAgo: 3, tool: "claude",
    title: "File the September VAT return before October 19",
    body: "Estimated amount: €8,400. Check the reverse charge on SumUp hardware purchases.",
    entities: [t("SumUp")],
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
    title: "Reset a shop's receipt printer",
    body: "1. Turn the printer off for 10 seconds.\n2. In the app: Settings > Devices > Forget the printer.\n3. Pair again over Bluetooth while holding the FEED button.\n4. Print a test receipt.",
    entities: [pr("POS")],
  },
  {
    author: "leo", zone: "support", kind: "fact", daysAgo: 4, tool: "claude",
    title: "Top 3 October tickets: printer, POS sync, Excel export",
    body: "62 tickets in total, 24 of them about the printer. The Excel export and the offline PWA would remove half of the volume.",
    entities: [t("Excel"), pr("POS")],
  },
  {
    author: "sarah", zone: "support", kind: "task", daysAgo: 1, tool: "claude",
    title: "Write the FAQ on offline sync",
    body: "Explain what happens when the shop loses the network and how to force a sync.",
    entities: [pr("POS")],
  },
  // --- Leadership ---
  {
    author: "claire", zone: "leadership", kind: "fact", daysAgo: 9, tool: "claude",
    title: "Q4 goal: 120 bakery customers and €25k MRR",
    body: "We are at 85 bakeries and €17.8k MRR as of October 1. Preorders and La Mie Dorée are the two main levers.",
    entities: [c("La Mie Dorée"), pr("Preorders")],
  },
  {
    author: "claire", zone: "leadership", kind: "decision", daysAgo: 7, tool: "claude",
    title: "Seed round postponed to March 2027: profitability first",
    body: "With 14 months of runway, we would rather raise with €30k MRR. The board approved it on October 2.",
    entities: [],
  },
  {
    author: "claire", zone: "leadership", kind: "task", daysAgo: 4, tool: "claude",
    title: "Hire a mobile developer by January",
    body: "For the POS PWA then the preorder app. Job description to validate with Hugo.",
    entities: [p("Hugo Bernard")],
  },
  {
    author: "claire", zone: "leadership", kind: "fact", daysAgo: 1, tool: "claude",
    title: "Quarterly board on November 12: MRR, churn and NPS KPIs",
    body: "Jean-Marc prepares the financials, Léo the NPS and preorder adoption.",
    entities: [p("Jean-Marc Dubois"), p("Léo Petit")],
  },
]

/** Typical prompts per zone, for the history and the simulator. */
export const DEMO_PROMPTS: Record<string, { user: string; text: string }[]> = {
  dev: [
    { user: "hugo", text: "Why is the Stripe invoice.paid webhook failing in prod this morning?" },
    { user: "ines", text: "Fix the stock computation when the shop closes offline" },
    { user: "hugo", text: "Prepare the Supabase migration for the preorders table" },
    { user: "ines", text: "Write the Playwright tests for the payment flow" },
  ],
  product: [
    { user: "leo", text: "Write the spec of the pickup slots for preorders" },
    { user: "leo", text: "Summarize the user feedback on the batch screen" },
  ],
  sales: [
    { user: "sarah", text: "Prepare a yearly sales proposal for Maison Kayser Lyon" },
    { user: "sarah", text: "Summarize the pipeline and the deals in negotiation this week" },
  ],
  finance: [
    { user: "jeanmarc", text: "Prepare the September VAT return from Pennylane" },
    { user: "jeanmarc", text: "Update the cash forecast with the Stripe payouts" },
  ],
  support: [
    { user: "hugo", text: "Why is the Rivoli shop's receipt printer not responding anymore?" },
    { user: "sarah", text: "Write the answer to the ticket about the Excel sales export" },
  ],
  leadership: [
    { user: "claire", text: "Prepare the MRR and churn KPIs for the November 12 board" },
    { user: "claire", text: "Where do we stand on the quarter's goals?" },
  ],
}

/** The prompt Jean-Marc runs every morning around 9am: the demo's automation suggestion. */
export const JEANMARC_DAILY_PROMPT = "Reconcile yesterday's Qonto statements with the Pennylane invoices and list the variances"

/** Fournil's skills: `zone` is the cortex that receives them (null: the whole company). */
export type DemoSkill = { author: string; name: string; description: string; zone: string | null; daysAgo: number; version?: number; files: SkillFile[] }

export const DEMO_SKILLS: DemoSkill[] = [
  {
    author: "claire", name: "fournil-tone", zone: null, daysAgo: 9,
    description: "Write an email, a post or a customer reply in Fournil's tone. Use it for any text meant for a baker.",
    files: [
      {
        path: "SKILL.md",
        content: `# Fournil's tone

Our customers are artisan bakers: they read between two batches, often on their phone.

- Short sentences, one message = one idea, polite and warm.
- Talk about their trade (batch, shop window, preorders), never about a "solution" or a "platform".
- No emoji, no exclamation mark.
- End with a clear action and a date when there is one.
- Sign with the person's first name, followed by "the Fournil team".
`,
      },
    ],
  },
  {
    author: "hugo", name: "deploy-fournil", zone: "dev", daysAgo: 8, version: 3,
    description: "Deploy Fournil to production (tag, Vercel, Sentry watch) and roll back if needed.",
    files: [
      {
        path: "SKILL.md",
        content: `# Deploy Fournil to production

1. Check that main is green: \`gh run list --branch main --limit 1\`.
2. Run \`scripts/release.sh <version>\`: it creates the vX.Y.Z tag, Vercel deploys prod.
3. Watch Sentry for 15 minutes (\`scripts/release.sh --watch\`).
4. If there is a new error: promote the previous release on Vercel, then tell #dev.

Supabase migrations are applied by CI on staging before the tag: never run them by hand in prod.
`,
      },
      {
        path: "scripts/release.sh",
        content: `#!/usr/bin/env bash
# Creates the release tag (Vercel deploys prod on the tag), or watches Sentry with --watch.
set -euo pipefail

if [[ "\${1:-}" == "--watch" ]]; then
  echo "New Sentry errors in the last 15 minutes:"
  sentry-cli issues list --project fournil-web --query "firstSeen:-15m" --status unresolved
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
    description: "Prepare the Fournil demo for a prospect: demo bakery, template catalog, a 20-minute run-through.",
    files: [
      {
        path: "SKILL.md",
        content: `# Prepare a customer demo

1. Create a demo bakery from the admin ("Demo" button), named after the prospect.
2. Import the template catalog (breads, pastries, cakes).
3. Run-through: morning batch, POS, sales export, then preorders.
4. Record in the brain what the prospect asked for (Sales zone), with the next step and its date.
`,
      },
    ],
  },
  {
    author: "hugo", name: "fix-printer", zone: "support", daysAgo: 3,
    description: "Guide a baker whose Bluetooth receipt printer is no longer responding.",
    files: [
      {
        path: "SKILL.md",
        content: `# Fix the receipt printer

1. Turn the printer off for 10 seconds.
2. In the app: Settings > Devices > Forget the printer.
3. Pair again over Bluetooth while holding the FEED button.
4. Print a test receipt. If nothing comes out: open a "hardware" ticket with the serial number.
`,
      },
    ],
  },
]
