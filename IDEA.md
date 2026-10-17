# NOS Brainer — your company's digital brain

> The name: a *no-brainer*. You paste a prompt into Claude Code, and your company has a brain.

> Screenpipe hackathon — "Build Agents That Remember", 42 Paris, October 2026

## The pitch

Every employee already uses AI (Claude Code, Codex, ChatGPT…), but all that context stays locked in individual sessions and gets lost.
We plug **Screenpipe** into each user's computer to capture these sessions, and we make them converge into **a single company brain**: all of its knowledge, shown on a dashboard, with per-team access.

Screenpipe becomes the **pipe** between the user's computer, their AI agents and the company's brain.

## How it works

### 1. Company onboarding (first creation of the brain)
- **5-10 min interview** to present the company: activity, teams, goals, useful links.
- **Scraping** of the links provided (website, docs, etc.).
- **Connectors**: Notion, Calendar, and every possible data source.
- Result: a first version of the brain, before anyone has even used the tool.

### 2. Onboarding of each user
- We provide **a prompt to paste into Claude Code**: a single command installs Screenpipe, only asks for the macOS permissions (screen, and accessibility as an option; no microphone), connects the MCP and the hooks, then **opens the brain directly** in the browser, where you see the computer light up and the brain fill up as work goes on.
- Then, nothing to do: **just by using Claude / Codex day to day**, the user feeds the brain.

### 3. The dashboard
- **A big visual brain**: each zone = a knowledge area of the company (dev, finance, sales, product…).
- **Live agents**: when an agent starts and goes looking for context, the zone concerned **lights up like a neon**.
- **Account and access management**: the admin creates the accounts and chooses which zones each person can see (e.g. finance does not need the code context).
- **Company status**: summary of where the company stands — tasks, goals, next steps, and **who did what**.
- **To-do**: connect the existing to-do tool (Todoist, Notion, Linear…) or offer one built into the dashboard.

### 4. The company's skills
The brain does not only keep knowledge: it also keeps **the company's skills** (ready-to-use know-how for Claude Code) and **the scripts they use**.
- **Publishing needs a permission**: to push a skill into the brain, you need a specific right, granted by an admin.
- **A Skills tab** in the dashboard gathers all the company's skills.
- **Assignment to a cortex**: a skill can be attached to a cortex of the brain (a zone: dev, finance, sales…). It is then only given to the people who have access to that context.
- **On the computer**: each employee automatically receives their skills in Claude Code (`~/.claude/skills`), and those no longer assigned to them are removed.

### 5. Automation proposals
We detect repetitive tasks from the recorded activity and propose them to the leaders.
> E.g.: every day at 9 am, Jean-Marc from finance runs the same prompt → we propose an automation that does it for him, and he gets the start of his day back.

### 6. Handover / replacement
When someone leaves or is away, their replacement gets **the context that role used the most** (not necessarily every conversation, see the legal part).

## Points to settle

- **Legal / GDPR**: employee consent, filtering of personal content, what goes up to the brain or not (distilled text rather than raw captures?), the employee's right of oversight.
- **Data volume**: Screenpipe produces about 19 GB in 2 weeks per computer. The brain must **distill** (facts, decisions, entities, links) and keep that persistently, not store the raw data.
- **Brain structure**: knowledge graph (people, projects, decisions, documents)? And how do we split the zones?
- **Local vs cloud**: Screenpipe is local by default. What goes to the shared brain, and when (continuously, every hour)?

## What we show at the hackathon (MVP proposal)

1. The install prompt that sets up Screenpipe and connects it to the brain.
2. A pipe that extracts the AI sessions (Claude Code…) and distills them into the brain.
3. The dashboard: the brain with its zones, the neons when an agent works, and the company status summary.
4. An automation suggestion detected from real activity.
