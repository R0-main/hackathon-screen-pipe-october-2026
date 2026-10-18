# Demo script (6 minutes; for the 3-minute final, keep steps 1, 2, 4, 5 and 7)

Questions after the demo: [jury Q&A](QA.md).

Fictitious company: **Encore**, refurbished smartphones sold online with a 2-year warranty, to individuals and to companies that equip their teams (18 people: 6 at the office, 12 technicians in the Lyon workshop; 2,100 phones a month, 40 business customers). AI is everywhere: it grades every phone's screen from the bench photos, sets the prices every night, answers 61% of the support tickets and drafts the CSR reports business customers ask for.

## Before going on stage

```bash
npm run seed -- --force          # starts from a clean brain (tokens shown in the terminal)
make demo                        # or the deployed URL (http://localhost:3000/demo)
npm run simulate -- --speed 1.5  # 2nd terminal, to start at the right moment (Ctrl-C to stop)
```

Tabs to prepare: the dashboard (`/dashboard`, entry through `/demo`) signed in as **Claire (CEO, admin)**, `/admin`, and a terminal with Claude Code on a real project if a computer is connected.

Online version: https://www.nos-brainer.tech (demo mode, fictitious data, seeded automatically on an empty database). Always with `www`: the address without `www` redirects, and the computer's client would lose its token in the redirect.

## Run-through

1. **The problem (30 s).** "Encore sells refurbished phones, with a workshop, an online shop and a B2B team. At Encore, everyone works with Claude Code or ChatGPT. But when Hugo figures out how to deploy, or Jean-Marc fine-tunes his bank reconciliation, that knowledge stays in their session."

2. **The brain (45 s).** The dashboard: each zone (Dev, Product, Sales, Finance, Support, Leadership) is a knowledge area, the dots are the most cited customers/tools/projects, the synapses link the zones that share entities. Start `npm run simulate`: the zones light up as sessions and MCP queries go by, the "Live agents" feed scrolls.

3. **How it gets there (45 s).** Show `/admin` → "Invite someone" → the **magic prompt**: you paste it into Claude Code, it installs Screenpipe, brain-sync, the MCP and the hooks. "The raw data stays on the computer: brain-sync filters, redacts the secrets and only sends distilled knowledge."
   *If a computer is connected:* `~/.company-brain/brain hello` → its neon lights up live; a question in Claude Code lights up the zone concerned.

4. **What only Screenpipe sees (45 s).** In "Knowledge", the items that no log could have given: Monday's team meeting distilled into a decision ("Black Friday prices freeze on November 17"), Sarah's call with Kalia Santé and her written promise, Jean-Marc's VAT procedure for Belgian companies worked out with ChatGPT in the browser, and what the computer's Screenpipe agent found by itself (Hugo's staging migration failing three times). In "Live agents": "Meeting distilled (Zoom)…", "Screenpipe agent found…". "Without Screenpipe, the brain would only hear the developers' terminals."

5. **Per-zone access (60 s).** Bottom left: "View as: Jean-Marc Dubois". The brain locks every zone except Finance. In "Knowledge", search "deploy" → nothing, the Dev procedures are closed to him; search "Qonto" → the daily Qonto ↔ Pennylane reconciliation. His agents get exactly these rights through the MCP. Go back to "View as: me".

6. **Where the company stands (45 s).** Goals, progress, next steps and who did what, per zone. For a version written by Claude with your subscription: before the demo, run `~/.company-brain/brain refresh-status` on the admin computer (the "Refresh the status" button recomputes the heuristic version on the server). Also show "View as: Jean-Marc": Jean-Marc only gets finance, with a headline computed on his zone.

7. **The automation (45 s).** The first card: "Jean-Marc runs this prompt almost every day around 09:03 (5 times over 5 days) → run it automatically Monday to Friday at 08:58" (the live demo's figures; a reseed recomputes them). Detected from the prompt fingerprints sent by the hooks, without storing the raw text. "Set it up". Below it, two cards marked as detected by Screenpipe: Sarah copies the trade-show leads into HubSpot every Monday, Léo sorts the Trustpilot reviews into Linear every Friday. "One computer sees one habit; the brain sees them across the team."

8. **The skills (30 s).** "Skills" tab: Encore's know-how ready for Claude Code, with their scripts (`deploy-encore` and its `release.sh`). "View as: Jean-Marc": he only gets the whole company's skill and those of the Finance cortex, and his computer installs them on its own. In `/admin`, the "Publishes skills" column: pushing a skill needs a permission.

9. **The handover (30 s).** `/admin` → "Handover" on Hugo: his zones, his tools, his recurring prompts and his knowledge. "The day Hugo goes on leave, the person replacing him gets all of this."

## Key lines

- "Encore gives phones a second life; NOS Brainer gives its team's know-how a life beyond the session."
- "Screenpipe is the pipe between the computer, its AI agents and the company's brain."
- "A few KB distilled per day instead of 19 GB of captures."
- "Finance does not need the code context, and neither do its agents."

## If something breaks

- No network / no computer connected: `npm run simulate` is enough for the whole demo.
- Slow capture: `~/.company-brain/brain sync --since 2h` forces the sync (backup source: the local Claude Code logs).
- Computer that does not light up: `~/.company-brain/brain doctor` says what is stuck (brain, Screenpipe, MCP, hooks, sync) and the command that repairs it.
- Damaged data: `npm run seed -- --force`.
