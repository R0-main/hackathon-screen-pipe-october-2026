# English-only migration: status and what is left

Decision: the whole product is English. No French anywhere (UI, server messages, CLI, prompts, demo data, docs,
comments, tests). French dictionary and language switcher are removed; zone ids and routes are renamed.
Work branch: `chore/english` (from `master` 8f7b77e). Delete this file when the migration is finished.

## Decisions already applied (keep them consistent)

- Zone ids: `produit` → `product`, `compta` → `finance`, `direction` → `leadership` (dev, sales, support unchanged).
  Zone names: Dev, Product, Sales, Finance, Support, Leadership.
- Routes (Next.js, `apps/web/app/(app)`): `/activity`, `/automations`, `/knowledge`, `/connectors`, `/entities`, `/status`,
  `/monitoring`, `/tasks`, `/admin/[[...view]]` (views `access`, `requests`, …), `/create`. `/accueil` deleted.
  Permanent redirects from the old French paths are in `apps/web/next.config.mjs` (`LEGACY_PATHS`): keep them.
- i18n: `apps/web/lib/i18n/dict.ts` exports `en` only; `useT()` in `components/I18n.tsx`; `<html lang="en">`; dates `en-GB`.
- Renames: `posteHealth` → `workstationHealth` (core), `frDate` → `shortDate` (client `format.ts`), `deNom` → `possessive`
  (web `install-prompt.ts`). Redaction masks: `[redacted]`, `[secret redacted]`, `[token redacted]`, `[IBAN redacted]`…
- Install prompts now start with "You are going to connect this computer to NOS Brainer, …", "You are going to ask to
  join NOS Brainer, …", "You are going to prepare the onboarding of NOS Brainer, …".
  `apps/client/src/secrets.ts` `INSTALL_PROMPT_RE` matches these AND the old French sentences (prompts already handed out):
  this French regex is intentional.
- Other intentional French left in code (legacy compatibility, do not remove): CLI flags accept `oui/non/aucun` besides
  `yes/no/none`; `skills.ts` `COMPANY_WIDE` accepts `entreprise/tous/…`; `install.ts` `LEGACY_PIPE_TITLE`;
  `doctor.ts` log parsing accepts old French log lines; `screenpipe.ts` `SELF_LABEL_RE` (`vous|moi|utilisateur`, labels
  of French chat UIs captured on screen); core `privacy.ts` may still hold a few French patterns on purpose — check.
- Search: `packages/core/src/search.ts` no longer adds tokens shorter than 3 letters taken out of multi-word synonyms
  ("go" from "go live" matched everything).
- Doctor check ids are English (`shortcut`, `folder`, `connection`, `schedule`, `last-sync`, `lock`, `pending`,
  `dry-run`, `log`, `hook-errors`, `claude-signin`, `scheduled-distillation`, `screenpipe-token`, `accessibility`);
  groups `Computer`, `Brain`, `Screenpipe`, `Claude Code`, `Sync`, `Distillation`. Hook error log lines: `[ISO] hook: msg`.
- Demo company Fournil keeps its proper nouns (people, customers like "La Mie Dorée", "Au Pain d'Antan").

## Done and verified

- `packages/core`: translated, `npx tsc` clean, 85/85 tests pass.
- `apps/web`: app, components, lib, scripts (demo-data, seed, simulate, smoke, eval-search, captures, migrate,
  embed-backfill), `public/install.sh`, `public/install.ps1` (must stay pure ASCII), `.env.example`, `DESIGN.md`,
  `PRODUCT.md`, `.impeccable`. Typecheck clean (ignore stale `.next/types`). `npm run smoke` all green on a fresh
  seed (`BRAIN_DATA_DIR=/tmp/x npm run seed -- --force && npm run smoke`). Search eval: p@1 83%, s@3 96%.
- `apps/client/src`: all modules translated (messages, help, comments).

## Left to do

1. **`apps/client/test/*.test.ts` (+ `fake-claude.ts`, `mock-brain.ts`, `helpers.ts`)**: still French. Many asserts match
   French output of the client (e.g. `sync-guards.test.ts` expects `écartée : …`). Translate the tests, and update
   expected strings to the new English output of `apps/client/src`. Run `npm test` in `apps/client` until green; fix the
   source only when the test reveals a real bug. Biggest files: sync-guards, install-script, install-prompt, screenpipe,
   claude-cli, doctor, codex-logs, install.
   - `install-prompt.test.ts` / `install-script.test.ts` check the web install prompt and `install.sh` / `install.ps1`
     messages: use the English strings now in `apps/web/lib/install-prompt.ts` and `apps/web/public/install.*`.
2. **Rebuild the client bundle**: `cd apps/client && npm run build` (writes `dist/brain.mjs`, `apps/web/public/brain.mjs`
   and `brain.mjs.sha256`). Must be done after any client change, then commit both files.
3. **New Supabase migration** (`supabase/migrations/20261018000001_english.sql`): rename zone ids
   `produit→product`, `compta→finance`, `direction→leadership` in every table/array that references zones (zones,
   knowledge_items.zone, tasks.zone, zone_access, agent_events.zones arrays, skills.zone, automations, status JSON…;
   read all migrations to find them), update zone names/descriptions to the English ones of `packages/core/src/zones.ts`,
   `profiles.title 'Visiteur de la démo' → 'Demo visitor'`. Idempotent, safe on an empty DB. Translate the comments of
   the existing migrations (do not change their SQL). Then `npm run db:migrate` against a local Postgres and run smoke
   with `DATABASE_URL` set.
4. **Repo docs and config**: `README.md` (keep a heading "## Deploy the shared brain (Vercel + Neon, free tiers)", the
   home page links to that anchor), `ARCHITECTURE.md`, `IDEA.md`, `STYLE.md`, `anas.md`, `install/PROMPT.md`,
   `docs/*.md` (CLI.md, LOCAL.md, AMELIORATIONS-V2.md → rename to IMPROVEMENTS-V2.md and fix links), `demo/DEMO.md`,
   `deploy/local/*` (brain-local.sh, env.example, Caddyfile), `compose.yaml`, `Dockerfile`, `.github/workflows/*.yml`
   (step names, messages; keep behavior). Old route names may appear in docs: use the new ones.
5. **Small leftovers spotted by the detector**: `apps/web/components/brain-geometry.ts`, `ScrollBrain.tsx`,
   `apps/web/lib/i18n/index.ts`, a few lines in `apps/web/scripts/smoke.ts` / `demo-data.ts` (mostly proper nouns: check),
   `packages/core/src/*.test.ts` (check: may be intentional French-input tests of the privacy filter — decide and note).
   Ignore `.claude/skills/**` and `.claude/skill-licenses/**` (third-party skills, not our product).
6. **Final checks**: typecheck core, web, client; core tests; client tests; web smoke; open the app (`/`, `/login` demo,
   dashboard, `/create`) and check no French is visible; final sweep with the tools below; then remove this file.

## Tools (in `docs/translation-tools/`, written for a WSL checkout at `~/nos_brainers`; edit `ROOT`/`cd` if elsewhere)

- `find-french.sh <paths…>`: lines that look French (accents, French words; `NOS_FR_LOOSE=1` skips accents). Noisy:
  English words like "capture", "lit" or proper nouns show up.
- `unknown-words.py <vocab dirs comma-separated> <targets…> [--lines]`: words of the targets never seen in the vocab
  dirs (already-English code). Best detector for accent-free French. Example:
  `python3 unknown-words.py packages/core,apps/web/app,apps/web/lib apps/client/test --lines`.
- `replace-lines.py BATCH.json` (`{"path": {"12": "new line"}}`) and `replace-strings.py BATCH.json`
  (`{"path": [["old", "new"], …]}`): batch edits. Line numbers must come from `grep -n` on the current file: a wrong
  number silently overwrites the wrong line, so check with `sed -n Np` first.
- French typography is a good tell: `" : "` (space before a colon), `« »`, `;` with a space before it.
