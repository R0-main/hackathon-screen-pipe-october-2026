# Demo script (5 minutes)

Fictitious company: **Fournil**, point-of-sale and pre-order software for artisan bakeries (6 people).

## Before going on stage

```bash
npm run seed -- --force          # starts from a clean brain (tokens shown in the terminal)
BRAIN_DEMO=1 npm run dev         # or the deployed URL
npm run simulate -- --speed 1.5  # 2nd terminal, to start at the right moment (Ctrl-C to stop)
```

Tabs to prepare: the dashboard (`/dashboard`, entry through `/demo`) signed in as **Claire (CEO, admin)**, `/admin`, and a terminal with Claude Code on a real project if a computer is connected.

Online version: https://cerveau-entreprise.vercel.app (demo mode, fictitious data, seeded automatically on an empty database).

## Run-through

1. **The problem (30 s).** "At Fournil, everyone works with Claude Code or ChatGPT. But when Hugo figures out how to deploy, or Jean-Marc fine-tunes his bank reconciliation, that knowledge stays in their session."

2. **The brain (45 s).** The dashboard: each zone (Dev, Product, Sales, Finance, Support, Leadership) is a knowledge area, the dots are the most cited customers/tools/projects, the synapses link the zones that share entities. Start `npm run simulate`: the zones light up as sessions and MCP queries go by, the "Live agents" feed scrolls.

3. **How it gets there (45 s).** Show `/admin` → "Invite someone" → the **magic prompt**: you paste it into Claude Code, it installs Screenpipe, brain-sync, the MCP and the hooks. "The raw data stays on the computer: brain-sync filters, redacts the secrets and only sends distilled knowledge."
   *If a computer is connected:* `~/.company-brain/brain hello` → its neon lights up live; a question in Claude Code lights up the zone concerned.

4. **Per-zone access (60 s).** In the top bar: "View as: Jean-Marc Dubois". The brain locks except Finance. Ask "how do we deploy to production?" → nothing, and the banner says the Dev zone might know more but is closed to him. Ask "Qonto reconciliation" → the procedure, and only the Finance zone lights up. Go back to admin.

5. **Where the company stands (45 s).** Goals, progress, next steps and who did what, per zone. For a version written by Claude with your subscription: before the demo, run `~/.company-brain/brain refresh-status` on the admin computer (the "Refresh the status" button recomputes the heuristic version on the server). Also show "View as: Jean-Marc": Jean-Marc only gets finance, with a headline computed on his zone.

6. **The automation (45 s).** The green card: "Jean-Marc runs this prompt almost every day around 09:07 (6 times over 6 days) → run it automatically Monday to Friday at 09:02". Detected from the prompt fingerprints sent by the hooks, without storing the raw text. "Set it up".

7. **The skills (30 s).** "Skills" tab: Fournil's know-how ready for Claude Code, with their scripts (`deploy-fournil` and its `release.sh`). "View as: Jean-Marc": he only gets the whole company's skill and those of the Finance cortex, and his computer installs them on its own. In `/admin`, the "Publishes skills" column: pushing a skill needs a permission.

8. **The handover (30 s).** `/admin` → "Handover" on Hugo: his zones, his tools, his recurring prompts and his knowledge. "The day Hugo goes on leave, the person replacing him gets all of this."

## Key lines

- "Screenpipe is the pipe between the computer, its AI agents and the company's brain."
- "A few KB distilled per day instead of 19 GB of captures."
- "Finance does not need the code context, and neither do its agents."

## If something breaks

- No network / no computer connected: `npm run simulate` is enough for the whole demo.
- Slow capture: `~/.company-brain/brain sync --since 2h` forces the sync (backup source: the local Claude Code logs).
- Computer that does not light up: `~/.company-brain/brain doctor` says what is stuck (brain, Screenpipe, MCP, hooks, sync) and the command that repairs it.
- Damaged data: `npm run seed -- --force`.
