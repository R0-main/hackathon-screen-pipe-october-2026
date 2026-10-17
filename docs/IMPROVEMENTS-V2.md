# Improvements v2: monitoring, connectors, language, real-time feed, brain quality

Branch `feat/ameliorations-v2`. Five work items, each usable on its own; everything works without a new npm dependency.
On Postgres, the migrations apply on their own on the Vercel production deployment and when the Docker container
starts (otherwise `npm run db:migrate`): `20261017000004_sync_reports.sql`,
`20261017000005_connectors_tasks.sql`, `20261017000006_search_quality.sql`. Without them, the brain stays usable:
monitoring without reports, task connectors refused with a clear message, search without vectors.

## 1. Monitoring (`/monitoring`, admins)

- **Sync reports**: at the end of each `brain sync` (except dry runs), the computer sends `POST /api/sync/report`
  with counters only (duration, knowledge items sent, duplicates, conversations per source, distiller, failures,
  redacted error). Never any content. History capped at 30 per computer (`sync_reports`, or the file's `sync_reports`).
- **State of each computer** (`packages/core/src/monitoring.ts`, `workstationHealth`): `ok`, `late` (more than 4 missed
  syncs, or activity without a report), `error` (last sync failed), `never` (never connected).
- **Server incidents**: every 500/503 error of a route is kept in memory (the last 100, deduplicated by route and
  message) and shown on the page, with the route concerned.
- **Alerts**: `BRAIN_ALERT_WEBHOOK` receives a JSON `{ text }` (Slack, Discord `/slack`, Mattermost, n8n…) for a route
  error, a failed sync on a computer, a failed connector. At most one alert per cause and per hour.
- **Probe**: `GET /api/health` answers 200 with version, uptime, storage, feed mode; 503 if the storage does not answer.
- API: `GET /api/admin/monitoring`.

## 2. Connectors (`/connectors`, admins)

Notion, Linear, Todoist and an ICS calendar (Google Calendar, Outlook). Settings in the company's settings
(`connectors` key, read and written by the API only); the token is never sent back to the browser.

| Tool | What enters the brain | How |
|---|---|---|
| Notion | the 40 most recently edited pages → knowledge (fact, procedure or decision depending on the title) | internal integration, `POST /v1/search` + blocks |
| Linear | open issues → tasks; those that disappear become done | API key, GraphQL |
| Todoist | open tasks → tasks; completed in Todoist → done here | API token, REST v2 |
| Calendar | meetings of the last 7 days and the next 14 → knowledge (who, when, about what) | private iCal address, through the anti-SSRF fetcher |

- The zone is the connector's if set, otherwise classified by keywords.
- Imported tasks carry `external_source`, `external_id`, `external_url` (update without duplicates, "Open in Linear" link).
- Sync on demand (`POST /api/connectors/:id/sync`) and automatic: when an admin views the dashboard, the active
  connectors that are due (every hour) run in the background.
- Pure, tested parsers in `packages/core/src/connectors.ts` (ICS, Notion blocks, Linear issues, Todoist tasks).

## 3. Interface language

- v2 introduced a French / English interface (dictionaries, language cookie, switcher). The product has since become
  English only: `apps/web/lib/i18n/dict.ts` exports the `en` dictionary alone, `<html lang="en">`, dates in `en-GB`,
  and the old French routes redirect permanently to the English ones (`apps/web/next.config.mjs`).
- `components/I18n.tsx`: `useT()` on the client; `lib/i18n/server.ts`: `getT()` for server pages. The dictionary keys
  stay typed, so the mechanism can take another language later (a `Dict` object and its code).

## 4. Real-time feed without rereading every 800 ms

- `BrainStore.onEvents(orgId, listener)`: local emitter on file storage; `LISTEN brain_events` on Postgres, notified by
  `pg_notify` in the insertion transaction (no trigger, no migration).
- `/api/stream`: immediate reread on notification (grouped over 30 ms), otherwise a safety reread with backoff
  (800 ms after an event, up to 15 s when idle; 4 s without notifications). A lost notification delays an event, it
  never makes it disappear. Header `X-Brain-Stream: local|notify|poll`.
- Variables: `BRAIN_EVENT_NOTIFY`, `DATABASE_LISTEN_URL` (pooler in transaction mode), `BRAIN_STREAM_POLL_MS`,
  `BRAIN_STREAM_IDLE_POLL_MS`. On Vercel, LISTEN is off by default (one connection per function).

## 5. Brain quality

- **Synonyms** (`packages/core/src/search.ts`): "go live" finds "deploy", "bill" finds "invoice". The expanded query is
  searched on top of the original query, and the two rankings are merged.
- **Optional semantic search** (`apps/web/lib/embeddings.ts`): Voyage AI (`VOYAGE_API_KEY`) or any OpenAI-compatible
  endpoint (`BRAIN_EMBEDDING_URL`, Ollama included for self-hosting). Vectors stored as `real[]` (no pgvector
  required), cosine on the server, RRF fusion with the lexical search (`hybridSearch`). `npm run embed` vectorizes
  existing data. The MCP and the dashboard benefit from it without changes.
- **Near-duplicates and replacements** on ingestion (`likeness`): same content (Jaccard ≥ 0.8) → dropped; same subject
  (close titles, same type decision / procedure / fact) but different content → the new one replaces the old one
  (`superseded_by`), which stays readable by its author but leaves the searches, the lists and the status summary.
- **Entities** (`/entities`, `/entities/:type/:name`): everything about a customer, a project, a tool, and the entities
  cited with it. The entity tags of the knowledge cards are clickable.
- **Evaluation**: `npm run eval` (after `npm run seed`) measures precision@1, success@3 and MRR on 24 questions worded
  differently from the titles (synonyms, paraphrases). To run again after any change to search.

## Checks

- `npm run typecheck` and `npm test` (CI): tests added in `packages/core` (search, connectors, monitoring) and
  `apps/client` (report).
- `npm run smoke`: monitoring, connectors (external tasks), quality (replacement, entities, notified feed) sections.
