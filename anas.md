# Anas's notes: review of the MVP against the real screenpipe API

> Written on 16/10/2026 in the evening, after reading the whole `screenpipe/screenpipe` repo (commit `9dc0fd0`, ~490k lines)
> and our branch `claude/great-euler-flq450` (commit `632e5d8`). The paths quoted are those of these two repos.
> The points marked *(to check)* could not be tested on a real instance.

## Progress (branch `fix/screenpipe-api`, 17/10)

| Point | State |
|---|---|
| 2.1 `parsed` format (`items`, `actors`) | done: messages with roles, conversation title, `content.text` fallback |
| 2.2 semantic parser | done: `brain.mjs status` says whether `parsed` returns data; instruction in the install prompt (`--enable-semantic-context` / "memory" app context) |
| 2.3 authentication | done: `X-Screenpipe-Client: api` + `X-Screenpipe-Agent` headers, token through `npx -y screenpipe@latest auth token`, explicit 401/403 |
| 2.4 `browser_url` | done: allowlist and tool derived from the tab's URL |
| 2.5 pagination / checkpoint | already done on the MVP side (time windows, safe checkpoint); pages of 100, the server enforces no cap |
| 2.6 workflow details | done: `GET /workflows/:id` → occurrences, days, usual time, minutes per week (`timingRuns`) |
| 2.7 `filter_pii=true` | done |
| 2.8 meetings | done: `GET /meetings` + transcripts → "meeting" conversations, checkpoint per meeting, `--screenpipe-meetings no` to opt out |
| 2.9 `brain-sync` pipe | done: `brain.mjs install-pipe` writes `~/.screenpipe/pipes/brain-sync/pipe.md` (frontmatter to validate on a real computer with `pipe run`) |

Still to do: a run on a real Screenpipe instance (response shapes read in the repo's code, not tested in real
conditions), aggregating workflows across computers on the dashboard side (section 1, point 4), and the pitch (section 1, point 5).

## 0. In two sentences

The idea is good and the MVP is impressive. But as coded, screenpipe is **optional** in it (the Claude Code logs and the
hooks do the real work), while the kickoff recap says: *"a generic agent without a screenpipe connection does not meet the
judging requirement"*. The fixes below make screenpipe **irreplaceable** (meetings, AI tools without logs, native pipe,
distribution through Teams) and fix five bugs that would leave the brain empty on stage.

## 1. Risk no. 1 with the jury, and how to turn it around

What the jury will see in our README: *"the local Claude Code logs are the most reliable source"* and the hooks make the
neons reliable *"without depending on screen capture"*. On top of that, screenpipe already does part of what we announce:

| What we announce | What screenpipe already has (in its code) |
|---|---|
| Capture the Claude Code / Codex sessions | `claude_code.rs`, `codex.rs`, `hermes.rs` connections in `screenpipe-connect`, and the October changelog: "local Claude Code, Codex and Hermes chats can contribute evidence" |
| Log of AI prompts | Built-in `ai-prompt-journal` pipe |
| Lasting memory | `memories` table, `content_type=memory`, `commitments` pipe |
| "Same prompt, same time, 3 days" detection | `automate-my-work` pipe + per-person workflow catalog (`/workflows`) |
| Push a config to the whole team | **Teams**: pipe configs and filters pushed end-to-end encrypted |
| Multi-computer brain | Enterprise gateway (`screenpipe-gateway`), `screenpipe-team-memory` crate |

The countermeasure, by order of impact:

1. **Put meetings into the brain** (section 2.8). "On Monday's call, Claire decided to postpone the closing": no Claude
   Code log contains that, only screenpipe transcribes, diarizes and detects meetings.
2. **Show the AI tools without logs or hooks**: ChatGPT web, Claude desktop, Cursor, Gemini. Only `content_type=parsed`
   structures them (semantic parser, 49 apps covered). The hooks stay for the latency of the neons, not as a source of truth.
3. **Ship `brain-sync` as a real screenpipe pipe** (section 2.9) and **distribute it through screenpipe Teams**: it is word for
   word track 3, "setup, approvals and shared tools", with the product's own primitives.
4. **Aggregate workflows across employees**: "this workflow exists on 3 computers". A single computer cannot see it, nor can
   the product. It is their tagline ("finds work worth automating in your company") at the company's scale.
5. **Self-hosting by default in the pitch** (file mode / any Postgres). Supabase and Vercel = an option.

Argument to quote as is: their spec `docs/ORG_DATA_UNIFICATION_SPEC.md` says *"sqlite does not federate, 30 employees = 30 dbs,
not one queryable org brain"* and *"ship only the ~30 frames a SOP cites, not the firehose"*. Our principle "the raw data stays
on the computer, only the distilled knowledge goes up" is exactly that. We are building the layer they describe as missing.

Pitch line: *"screenpipe remembers for one person; its own spec says 30 employees make 30 databases. We built the brain on
top, and only the distilled knowledge goes up to it."*

## 2. What breaks on real data, and the fixes

### 2.1 The `parsed` format we expect does not exist

`apps/client/src/sources/screenpipe.ts` → `normalizeScreenpipeItem` looks for `content.messages[{ role, text }]`. Real shape of a
`parsed` row (`crates/screenpipe-engine/src/routes/content.rs`):

```jsonc
{
  "type": "parsed",
  "content": {
    "frame_id": 1234, "timestamp": "2026-10-16T21:03:11.120Z",
    "app_name": "Google Chrome", "window_name": "ChatGPT", "browser_url": "https://chatgpt.com/c/...",
    "text": "…compact rendering of the conversation…",
    "parser_id": "conversation/chatgpt-web", "parser_version": "…",
    "items": [
      { "local_id": "c1", "parent_local_id": null, "kind": "conversation", "title": "Monthly closing", "body": null, "actor": null, "occurred_at": null, "status": null, "metadata": {} },
      { "local_id": "m1", "parent_local_id": "c1", "kind": "message", "title": null, "body": "How do we do the Qonto reconciliation?", "actor": "You", "occurred_at": "2026-10-16T21:01:00Z", "metadata": {} },
      { "local_id": "m2", "parent_local_id": "c1", "kind": "message", "body": "Here is the procedure…", "actor": "ChatGPT", "occurred_at": "2026-10-16T21:01:40Z", "metadata": {} }
    ],
    "actors": [ { "item_id": 9, "local_id": "m1", "actor_id": 3, "name": "Jean-Marc Dubois", "observed_name": "You", "assignment_source": "heuristic" } ]
  }
}
```

Values of `kind`: `conversation`, `message`, `document`, `task`, `page`, `calendar_event`, `derived`, `stable`. There is **no**
`role`. Today we fall back on `content.text` and build a fake conversation ("Session captured on screen" + the whole blob on
the assistant's side): distillation loses who said what.

Fix: in the normalizer, take the `items` with `kind === "message"`, group them by `parent_local_id`, and derive the role
from `actor`: `You`, the labels of chat UIs in other languages, the user's name → `user`;
`ChatGPT`/`Claude`/`Assistant`/`Codex`/`Gemini`/`Copilot` → `assistant`. `occurred_at` gives `at`. Keep `content.text` as a
fallback if `items` is empty.

### 2.2 `parsed` stays empty as long as the semantic parser is off

`enableSemanticContext` is `false` by default (`crates/screenpipe-config/src/recording.rs`, line ~966). Our
`install/PROMPT.md` does not turn it on, so `parsed` answers empty, we fall back on `accessibility`, and we get the whole chat
history on every capture, structure lost.

Fix: add to step 3 of the install prompt turning on the semantic parser (setting in the desktop app, or CLI flag
`--enable-semantic-context` *(exact name to check in `screenpipe record --help`)*), then a check:
`GET /search?content_type=parsed&start_time=10m%20ago&end_time=now&limit=5` must return rows after a few minutes of activity
in ChatGPT or Claude.

### 2.3 Authentication is silently broken

`/health` has **no auth**, so `screenpipeHealth` passes. But `/search` returns 401/403 without a token, and
`fetchScreenpipeItems` takes a `status >= 400` on page 0 for "no data". Current builds turn auth on by default (the browser
extension pairs precisely to get the token).

Fixes:
- `brain.mjs init` gets the token on its own: `npx -y screenpipe@latest auth token` (it is also what their skill does), and
  stores it in `screenpipe_token`.
- Tell 401/403 apart in the warnings ("screenpipe token required") instead of "no data (parsed, accessibility, ocr)".
- Send the expected headers: `Authorization: Bearer <token>`, `X-Screenpipe-Client: api`, `X-Screenpipe-Agent: company-brain`.

### 2.4 The browser URL is never passed on

`isAllowedApp(app, window, whitelist, browserUrl)` and `AI_HOSTS` are well done, but the normalizer does not read
`content.browser_url` (present on `parsed` and `ocr`) and `groupScreenpipeItems` does not pass it. Detecting the ChatGPT /
Claude tabs therefore only relies on the window title.

Fix: add `browserUrl: str(c.browser_url)` to `ScreenpipeItem`, and pass it to `isAllowedApp`.

### 2.5 Pagination and checkpoint

100 rows × 10 pages max, all apps together, filtered on the client. Accessibility captures every few seconds: 15 minutes of
activity easily go past 1,000 rows. When it truncates, the checkpoint still moves up to the most recent row seen. If the API
returns from newest to oldest *(to check)*, the old rows lost are never caught up.

Fixes:
- one call per allowed app with the server filter `app_name=` (or `browser_url=` for the AI tabs), instead of reading everything;
- `fields=type,content.timestamp,content.app_name,content.window_name,content.browser_url,content.text,content.items,content.frame_id`
  and `max_content_length` to lighten it;
- when `truncated` is true, put the checkpoint on the **oldest** row processed, not the most recent one.

### 2.6 `/workflows` does not return what `mapWorkflows` looks for

Real shape of the list (`crates/screenpipe-engine/src/routes/workflows.rs`):

```jsonc
{ "data": [ { "id": "…", "title": "…", "description": "…", "trigger": "…", "outcome": "…",
              "evidenceStatus": "…", "catalogStatus": "…", "stageCount": 4 } ],
  "pagination": { "total": 12, "offset": 0, "limit": 20 }, "analyzedAt": "…", "historyRestricted": false }
```

No `occurrences`, `days` or `schedule` field: our suggestions coming from screenpipe arrive with 0 minutes saved and end up
at the bottom of the list. The steps, the observed procedure, the quotes, the `timingRuns` and the occurrence episodes are in
`GET /workflows/{id}?include_automation=true`.

Fix: list, then call the detail for the first N, and derive `occurrences` / `days` from the episodes; show `trigger` and
`outcome` in the card. It is also the basis of the aggregation across computers (section 1, point 4).

### 2.7 screenpipe's native redaction is ignored

`/search` accepts `filter_pii=true`: redaction of personal data **on the computer**, even before our regex filter
(`crates/screenpipe-engine/src/routes/search.rs`, line ~1497). One parameter to add, and a pitch line: two layers of
redaction, one of them signed screenpipe.

### 2.8 Meetings, the strongest source, are not connected

Endpoints (`crates/screenpipe-engine/src/server.rs`, lines ~940-960):

- `GET /meetings?start_time=…&end_time=…&limit=20&offset=0&q=…` →
  `[{ id, meeting_start, meeting_end, meeting_app, title, attendees, note, detection_source, created_at }]`
  (`note` contains the summary saved by the user or by the `meeting-summary` pipe).
- `GET /meetings/{id}/transcript` → array of segments `{ speaker_name, speaker_id, transcript, captured_at, device_type, … }`.
- `GET /meetings/status` → meeting in progress.

To add in `sync.ts`: a `meetings` source that turns each meeting finished since the checkpoint into a `Conversation`
(one message per segment, `role` = `user` if `speaker_name` is the employee, otherwise `assistant`, or better: a "Name: text"
rendering in a single message), then the usual distillation. The distillation prompt gets one more line: "for a meeting,
decisions and commitments come first". Demo: a fictitious 2-minute meeting between two team members → 3 decisions in the
zone concerned.

### 2.9 Ship `brain-sync` as a screenpipe pipe

A pipe is a `pipe.md` whose prompt is run by an agent (Pi by default, or Claude Code, Codex…) that has a bash.
That makes brain-sync visible in "Scheduled tasks", triggerable at the end of a meeting, bounded by permissions, and
**pushable to the whole team through screenpipe Teams** (end-to-end encrypted configs). Example, to put in
`~/.screenpipe/pipes/brain-sync/pipe.md`:

```markdown
---
schedule: every 15m
enabled: true
title: Company brain, sync
description: Distills the AI sessions and meetings into the shared brain (nothing raw leaves the computer)
agent: pi
model: auto
timeout: 300
subagent: false
history: false
trigger:
  events:
    - meeting_ended
permissions:
  allow:
    - Api(GET /search)
    - Api(GET /meetings)
    - Api(GET /meetings/*)
    - Api(GET /workflows)
    - Api(GET /workflows/*)
privacy_filter: true
---

Run `node ~/.company-brain/brain.mjs sync` with this task's `$SCREENPIPE_LOCAL_API_KEY` token.
Read no data yourself, send nothing anywhere else. Report in one sentence the number of knowledge items sent
and any warnings. If the command fails, report the error as is.
```

The task's token is **scoped** by `permissions.allow`: even if brain.mjs wanted to read something else, the API would refuse.
`privacy_filter: true` forces `filter_pii` on every read of the pipe. Keep our launchd / cron / schtasks installer as a
fallback for computers without the desktop app.

Bonus: `POST http://localhost:11435/notify` with `title`, `body` (markdown), `priority` and `actions` (`chat`, `link`,
`pipe`, `api`) → a native notification "4 knowledge items sent to the brain, 1 decision to confirm".

## 3. screenpipe API reference (what we use)

Base: `http://localhost:3030`. Token: `npx -y screenpipe@latest auth token` (or Settings → Privacy → API security).
Headers on every call: `Authorization: Bearer <token>`, `X-Screenpipe-Client: api`, `X-Screenpipe-Agent: company-brain`.
Without auth: `/health`, `/ws/health`, `/notify`, `/pipes/store/*`.

`GET /search`: `q`, `app_name`, `window_name`, `browser_url` (normalized match, not a substring: for a domain use `q=`),
`content_type` ∈ `all | ocr | audio | input | accessibility | memory | parsed`, `start_time` / `end_time` (ISO 8601 or
relative `30m ago`, `24h ago`), `limit` (no server cap, aim for ≤ 100), `offset`, `fields=` (dotted paths),
`format=json|csv|tsv`, `max_content_length`, `filter_pii=true`, `focused=true`, `frame_id` / `actor_id` (with `parsed` only).
Response: `{ data: [ { type, content: { … } } ], pagination: { limit, offset, total } }` (`total` can be an estimate: stop on
an empty page, not on `total`). Content per type: `ocr` → `text`, `app_name`, `window_name`, `browser_url`, `timestamp`,
`frame_id`; `audio` → `transcription`, `speaker`, `timestamp`; `accessibility` → `text`, `app_name`, `window_name`;
`input` → `event_type` (`click`, `key`, `text`, `scroll`, `app_switch`, `window_focus`, `clipboard`), `x`, `y`, `app_name`,
`window_title`, `browser_url`, `element_role`, `element_name`; `parsed` → section 2.1.

`GET /activity-summary?start_time=…&end_time=…`: entry point recommended by their own skill before `/search`:
apps, windows, active minutes per app, excerpts, `data_status` ∈ `ok | empty_but_recording | no_capture_in_range | not_recording`.
Useful for the "handover" page (zones and tools really used by a computer).

`GET /meetings`, `GET /meetings/{id}`, `GET /meetings/{id}/transcript`, `GET /meetings/status`: section 2.8.

`GET /workflows?q=&limit=&offset=`, `GET /workflows/{id}?include_automation=true`: section 2.6.

Semantic parser: `enableSemanticContext` (default `false`), families conversation, mail, editor, task, calendar, page,
terminal; 49 apps including ChatGPT web, Claude macOS, Claude web, Codex, Cursor, Windsurf, Gemini, Slack, Teams, WhatsApp,
Gmail, Outlook. Claude Code in a terminal goes through the "terminal" family (raw transcript, noisy because of the interface
re-rendering): for that tool, our JSONL logs stay better. It must be said honestly, and the tools where screenpipe is
irreplaceable must be shown.

Pipes: frontmatter `schedule` (`every 15m`, `daily`, cron, `manual`), `enabled`, `title`, `description`, `agent`, `model`,
`timeout`, `subagent`, `history`, `trigger.events` (`meeting_started`, `meeting_ended`, `pipe_completed:<name>`),
`permissions.allow` (`Api(GET /search)`…), `privacy_filter`, `artifacts`. CLI: `npx -y screenpipe@latest pipe install|enable|run <name>`.
Logs: `screenpipe pipe logs <name>`. There is no "when the screen shows X" trigger: only schedules, meetings and the end of
another pipe.

MCP: `npx -y screenpipe-mcp@latest`, tools `search-content`, `activity-summary`, `list-meetings`, `get-meeting`,
`list-workflows`, `get-workflow`, `frame-context`, `get-frame-elements`, `send-notification`, `team-search`, `team-records`…
The desktop app also accepts custom MCP servers: we can declare `company-brain` there so that screenpipe's scheduled tasks
read the brain (a closed loop inside the product).

## 4. What is solid in the MVP, not to touch

- Up-to-date Claude API: `messages.parse` + `zodOutputFormat`, `fallbacks: "default"` with the beta header `server-side-fallback-2026-07-01`,
  `effort` per call, no forced `tool_choice` (which would give a 400 on Sonnet 5.5).
- Hooks: exit code 0 guaranteed, hard timeout at 2.5 s, one-line stdout on `SessionStart`, prompt fingerprint without raw text.
- Sync: file lock with orphan detection, atomic writes, per-conversation checkpoints, full uninstall.
- Privacy: allowlist by whole words, strong and weak signals, Luhn, IBAN, redaction replayed on the server, per-zone access in
  the API and in SQL RLS.

## 5. Priority order for the night

1. 2.2 + 2.3: turn on the parser and auth, check that `parsed` is not empty on a real computer (otherwise everything else is invisible).
2. 2.1 + 2.4: real `items` → messages mapping, `browser_url` in the allowlist.
3. 2.8: meetings source (the big win with the jury), with a fictitious meeting recorded before the demo.
4. 2.9: brain-sync `pipe.md` + screenshot of "Scheduled tasks" and of Teams for the slides.
5. 2.6: workflows (detail) + "present on N computers" aggregation in the dashboard.
6. 2.5 + 2.7: pagination per app, `fields=`, `filter_pii=true`.
7. Pitch: track 3 announced, quote of the unification spec, self-hosting by default.
