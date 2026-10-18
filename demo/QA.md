# Jury Q&A

The questions the jury is likely to ask after the demo, with a short answer (20 to 30 seconds) and, when it helps, what
to show. Companion of the [demo script](DEMO.md). Details and code paths: [README](../README.md),
[REFERENCE](../docs/REFERENCE.md), [ARCHITECTURE](../ARCHITECTURE.md).

## In one sentence

**"So what is it?"**
Screenpipe is one person's memory; NOS Brainer is the company's. Every computer's Screenpipe and AI agents feed one
shared brain with distilled knowledge (decisions, procedures, facts), and every agent in the company queries it through
MCP, with the rights of its owner.

## Screenpipe (30% of the grade)

**"Would NOS Brainer lose its purpose without Screenpipe?"**
Yes. Without it, the brain only hears the coding agents that write logs: the developers. Sales and finance work in
ChatGPT or Claude in the browser, decisions are made in Zoom calls, repeated work happens across apps. None of that
leaves a log. Screenpipe is what makes it a company brain and not a developers' brain.
*Show:* Knowledge, the items marked `source: meeting (Zoom)`, `source: chatgpt (Google Chrome)`, `source: agent (Screenpipe)`.

**"What exactly do you use from Screenpipe?"**
Five things, all local on the computer:
- `/search` with the semantic parser (`content_type=parsed`, `filter_pii=true`), so a ChatGPT tab becomes a conversation;
- `/meetings` and their transcripts, so decisions made in a call reach the brain;
- `/workflows`, the repeated sequences Screenpipe detects, which become automation suggestions;
- the Screenpipe MCP, read-only tools only: on each sync, Claude Code explores the recent activity itself (the "Screenpipe agent");
- the install: `brain setup` installs and starts Screenpipe and opens the macOS permissions at the right place.

Code: `apps/client/src/sources/screenpipe.ts`, `apps/client/src/agent.ts`, `apps/client/src/setup.ts`.

**"Screenpipe already has a lot of features. Why not use it as is for a team?"**
Screenpipe solves memory for one person. Its own spec says it: "sqlite does not federate, 30 employees = 30 dbs, not one
queryable org brain". We don't replace Screenpipe; we federate it: each computer keeps its capture, and only what is
worth sharing goes up.

**"Screenpipe records about 19 GB in two weeks. You send all that?"**
No. The raw capture never leaves the computer. `brain-sync` reads it, filters it, distills it, and sends a few KB of
knowledge per day. `~/.company-brain/brain sync --dry-run --full` shows exactly what would be sent.

**"Do you record people's microphones?"**
Not by default. Meetings are read from Screenpipe's transcripts only when the employee turns audio on at install
(`setup --audio yes`).

## Privacy and trust

**"Isn't this employee surveillance?"**
It is built the other way around. The employee installs it themselves with one prompt; the raw capture stays on their
computer; only AI apps, terminals and AI sites are read; personal content is dropped before anything is sent; and everyone sees what
they brought to the brain and can delete it. A manager never sees what someone typed, only the knowledge it produced.

**"What do you remove before sending?"**
On the computer, then again on the server: secrets, API tokens, private keys, webhooks, credentials, emails, phone
numbers, IBANs, social security numbers. Content that looks personal (health, personal finances, private life) is
dropped, not redacted. Only an allowlist is read: AI apps, terminals and editors, AI sites in the browser. Code:
`packages/core/src/privacy.ts`.

**"And GDPR?"**
The design follows data minimization: distilled text instead of captures, a right of review for each employee, removed
text kept nowhere, and a self-hosted option where nothing leaves the company. Each company still has to inform its
employees; the Enterprise plan includes help with informing employee representatives.

## Security

**"How do you make sure finance doesn't read the code context?"**
Per-zone access, checked on every API route and in Postgres row-level security. An agent uses its owner's token, so it
inherits exactly their rights. Tokens are stored hashed (SHA-256); the AI-app connector key is derived from the token,
signed by the brain, and revoked by regenerating the token.
*Show:* "View as: Jean-Marc", then search "deploy" (nothing) and "Qonto" (the reconciliation).

**"What about prompt injection? People's chats end up in agents' context."**
Three layers. The distillation prompt treats captured content as data, never as an instruction. A Claude moderator
(on an admin's Claude Code subscription) rereads new knowledge every 15 minutes and removes what looks like an instruction to an AI ("suspicious instruction"),
along with anything personal, secret, vague or duplicated. And the Screenpipe agent only gets read-only tools.

**"What if wrong or outdated knowledge gets in?"**
The moderator keeps, fixes or removes it; a revised decision replaces the old one in search; authors can delete their
own items and admins any item.

## Agents and MCP

**"How does an agent actually use the brain?"**
Through the company MCP server, installed in Claude Code and Codex by the prompt: `search_brain`, `get_document`,
`get_zone_summary`, `company_status`, `remember` and more (14 tools). Each query lights up the zone it read on the
dashboard. For Claude, ChatGPT, Cursor or VS Code there is "Connect an AI" on each person's page: a connector address,
no install needed. That is how sales and finance use it.

**"What are the views that open inside Claude?"**
MCP Apps: `show_brain`, `show_automations` and `show_team` return an interactive view that Claude (web and desktop),
ChatGPT and VS Code render in the conversation: the live 3D brain, the automations to approve, the org chart. Claude
Code gets a text answer from the same tools.

**"Isn't this just RAG over chat logs?"**
Retrieval is one piece. The product is upstream and around it: capture from places no log covers (Screenpipe), privacy
filtering on the computer, distillation into typed knowledge (decision, procedure, fact, task), zones and rights,
documents that travel with their knowledge, automations detected from behavior, and agents that can write back with
`remember`.

## Product

**"What happens when someone leaves or goes on leave?"**
Handover: their page shows their zones, tools, recurring prompts and knowledge; the replacement starts from there.
*Show:* `/admin`, "Handover" on Hugo.

**"How does the brain know the company's structure?"**
On `/create`, a few questions, then Claude proposes the zones from the team's past conversations and connected tools.
Then every day, Claude rereads the last 30 days and creates a zone when a recurring area of work has none.

**"Where do the automations come from?"**
Two sources: prompts someone repeats (detected from fingerprints sent by the hooks, without storing the raw text) and
Screenpipe's workflows on each computer. An admin sets them up or dismisses them.

**"What about documents?"**
The files an AI session worked on (PDF, Word, Excel, PowerPoint, CSV…, 3 MB at most) travel with the knowledge drawn
from them, in the same zone, with the same rights. Never a folder scan, and a file with secrets or personal papers stays
on the computer. Agents open them with `get_document`.

**"Does it work with tools we already have?"**
Notion, Linear, Todoist, calendars, and a catalog of 40+ official remote MCP servers (OAuth 2.1): Claude imports their
content read-only into the right zone. The company's Claude Code skills are shared too, by zone, and installed
automatically on the right computers.

## Cost, scale and business

**"What does it cost to run?"**
Distillation runs on each employee's Claude Code subscription (`claude -p`): no API key needed. Without Claude, local
heuristics still work. Hosting fits the free tiers of Vercel and Neon, or one Docker machine with local HTTPS.

**"Does it scale to a real company?"**
Each computer sends a few KB of distilled text every 15 minutes from its own checkpoint, so 30 computers are 30 small
streams into Postgres. The MCP server is stateless HTTP. One brain can host several companies.

**"Who pays, and how much?"**
Self-hosted: free, unlimited seats. Team, on our cloud in Europe: €8 per seat per month (yearly), up to 50 seats.
Enterprise: SSO, access log, region and retention of choice. Prices are indicative: payment is not open yet.

**"Who is the customer?"**
Companies of 10 to 200 people where everyone already works with AI: startups, agencies, SMBs. The buyer is the CEO or
the head of operations who sees the same questions answered five times. Regulated companies self-host.

**"How is it different from enterprise search tools?"**
They index what is written down: documents and apps. NOS Brainer captures what people learn while working with AI,
including what is never written down (browser chats, calls), thanks to Screenpipe on each computer, and serves it back
to the agents themselves, with per-zone rights.

## The demo itself

**"Is the demo real?"**
The company is fictional (Encore) and its data is seeded, so anyone can explore it without connecting a computer. The
pipeline is real: the install prompt, the sync, the distillation, the MCP server and its views. Any visitor can connect
their own computer from the demo or create their own brain on `/create`.

**"How do you know it works?"**
Every push runs the typecheck, 300+ automated tests and the install scripts on Windows; changes to the self-hosting or
the local setup also run the Docker setup with HTTPS and `make dev` with and without Docker.

**"What's next?"**
Open payments, SSO for the Enterprise plan, and more MCP Apps. The core loop (capture, distill, share, query) is done.

## If you don't know

Say what is built and what isn't, and point to the README: it lists every feature with its code path. Better a short
honest answer than a long guess.
