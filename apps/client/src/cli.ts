// brain.mjs — the company brain's client on the employee's computer.

import { resolve } from "node:path"
import { trustConfiguredCa } from "./ca"
import { SOURCE_NAMES, UserError, applyScheduleEnv, brainHome, loadPartialConfig, selfCommand, selfScript, type SourceName } from "./config"
import type { DistillerKind } from "./distill"
import type { SyncSummary } from "./sync"

const VERSION = "0.1.0"
const BOOLEAN_FLAGS = new Set(["dry-run", "verbose", "purge", "help", "reset", "version", "full", "confirm", "scheduled", "no-open", "skip-screenpipe", "json"])

export function parseArgs(argv: string[]): { cmd?: string; flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h") flags.help = true
    else if (a === "-v") flags.verbose = true
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      const key = eq > -1 ? a.slice(2, eq) : a.slice(2)
      if (eq > -1) flags[key] = a.slice(eq + 1)
      else if (BOOLEAN_FLAGS.has(key)) flags[key] = true
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[key] = argv[++i]
      else flags[key] = true
    } else positional.push(a)
  }
  return { cmd: positional.shift(), flags, positional }
}

function help(): string {
  const me = selfCommand()
  return `NOS Brainer — computer client (v${VERSION})

Usage: ${me} <command> [options]

Commands:
  setup [--url <url> --token <token>] [--ca <pem>] [--audio yes|no] [--wait <seconds>] [--no-open] [--skip-screenpipe]
                     Everything in one command (it is what the install prompt runs): config, Screenpipe (installed and started
                     as a service if it is not running, microphone off by default), macOS permissions (settings opened, resumes as
                     soon as they are granted, --wait 300 s by default), MCP, hooks, sync every 15 min (upcoming activity
                     only), neon, then the brain opens in the browser. Can be run again without parameters.
                     Exit codes: 0 everything is connected; 3 everything but the screen recording permission (run setup again
                     once granted); 6 everything but Screenpipe (no version for this computer, or it does not start: see doctor).
  join --url <url> --join <team code> [--name <first last>] [--title <job title>] [--email <email>] [--wait-accept <seconds>]
                     Asks to join a company (it is what the team message runs): the computer's token is created
                     here, only its fingerprint goes with the request. Waits for an admin to accept it (--wait-accept 480 s by
                     default), then moves on to setup (same options, same codes). Code 7: still pending, \`join\` without
                     parameters resumes the same request. Code 8: request rejected.
  doctor [--json]    Diagnoses the computer, without changing anything: Node.js, shortcut, brain (connection, client version),
                     Screenpipe (capture, permissions, token), Claude Code (MCP, hooks), scheduled sync, distillation.
                     Each KO item gives the command that fixes it. --json: the same report for Claude Code ("safe" field
                     on the commands that only reconnect the computer). Exit code 1 if a KO item remains.
  init --url <url> --token <token> [--screenpipe-url <u>] [--screenpipe-token <t>] [--anthropic-key <k>]
       [--claude-token <token>] [--share-prompt-summaries yes|no] [--screenpipe-meetings yes|no] [--ca <pem>]
                     Saves the config (~/.company-brain/config.json, mode 600) and tests the connection.
                     --ca: certificate (PEM) of the authority of a self-hosted brain on local HTTPS; the client trusts
                     it for all its calls, on top of the public certificates ("none" to remove it).
                     Each option can be given alone to complete an existing config.
                     --claude-token: long-lived token created by \`claude setup-token\` (Claude subscription, no API key),
                     passed to every \`claude -p\` of the client, scheduled sync included ("none" to remove it).
                     --share-prompt-summaries no: the hook no longer sends any prompt summary (fingerprint only).
                     --screenpipe-meetings no: the meetings transcribed by Screenpipe are not distilled.
  hello              End-to-end test: your zones light up on the dashboard.
  sync [--dry-run [--full]] [--since 24h|7d|<ISO>] [--source claude|codex|screenpipe|all] [--limit N] [--verbose]
                     Reads the local AI sessions, filters (secrets, personal), distills and sends to the brain.
                     --dry-run shows what would be sent without sending anything (--full: each knowledge item in full),
                     and says what the preview does not contain (limit reached, captures not read, turns in progress).
                     If Claude fails, the conversation is retried later (never distilled without an LLM as a fallback),
                     and given up after 3 failures due to its content; an outage, a subscription limit or an
                     expired token does not count (if Claude no longer answers at all: given up after 24 h of failures).
                     At the end (outside dry runs), a report (counters only, never any content) goes to the dashboard's
                     Monitoring page: last sync, duration, errors.
  sync --confirm     Sends exactly what the last dry run showed (valid for 24 h).
                     Advanced options: --distiller heuristic|claude-cli|claude-api, --reset (ignores the checkpoints).
  skills [sync|list] Installs in ~/.claude/skills the company skills assigned to this computer (whole company, plus
                     those of the cortices you read) and removes those no longer assigned. Also done after each sync.
                     A personal skill with the same name is never touched. list: shows without installing anything.
  skills push <folder> [--cortex <zone>|company] [--name <name>] [--description <text>]
                     Publishes the folder (SKILL.md and the scripts it uses) to the brain; same name: next version.
                     Requires the right to publish skills (granted by an admin). Without --cortex: the one of the previous
                     version, or the whole company for a new skill. A file that contains a secret is refused.
  refresh-status [--dry-run]
                     Admins: writes "where the company stands" on this computer with Claude (\`claude -p\`, your subscription;
                     otherwise the API key) and sends it to the dashboard. --dry-run: shows the summary without sending it.
  refresh-zones [--dry-run]
                     Admins: "new zones" run done here by Claude Code (\`claude -p\`, your subscription;
                     in CI, CLAUDE_CODE_OAUTH_TOKEN from \`claude setup-token\`). The brain creates the missing zones
                     and files their knowledge in them. --dry-run: shows the proposals without sending anything.
  status             Client status in short: connection, last sync, Screenpipe, hooks, scheduling (details: doctor).
  mcp                "company-brain" stdio MCP server (connected by setup in Claude Code, user scope).
  hook               Claude Code hook handler (reads the hook's JSON on standard input).
  install-hooks      Adds the SessionStart, UserPromptSubmit and Stop hooks to ~/.claude/settings.json.
  install-schedule   Schedules "sync" every 15 min (launchd, crontab or Windows task), from now on for
                     every source (Screenpipe, Claude Code, Codex): history not read is never sent
                     automatically. Run after sync --confirm.
  install-pipe       Writes the "brain-sync" Screenpipe pipe (~/.screenpipe/pipes/brain-sync/pipe.md): the sync shows in Screenpipe's
                     scheduled tasks and runs again at the end of each meeting. Requires the Screenpipe app (pipe engine).
  uninstall [--purge] Removes hooks, scheduling, Screenpipe pipe, MCP, company skills and the Screenpipe service installed by setup;
                     --purge also deletes ~/.company-brain.

Variables: COMPANY_BRAIN_HOME (default ~/.company-brain, or --home <folder>), CLAUDE_CONFIG_DIR (default ~/.claude), CODEX_HOME (default ~/.codex).`
}

/** Sync report sent to the brain; a failure to send is never blocking. */
async function sendReport(input: { summary: SyncSummary | null; startedAt: number; error?: unknown }) {
  try {
    const { buildSyncReport } = await import("./report")
    const { BrainApi } = await import("./api")
    const cfg = loadPartialConfig()
    if (!cfg.url || !cfg.token) return
    await new BrainApi(cfg.url, cfg.token).report(buildSyncReport({ ...input, version: VERSION }))
  } catch (err) {
    if (process.env.COMPANY_BRAIN_DEBUG) console.error(`Report not sent: ${(err as Error)?.message ?? err}`)
  }
}

async function main(argv: string[]): Promise<number> {
  const { cmd, flags, positional } = parseArgs(argv)
  // --home: client folder (used by the Windows scheduled task, which does not inherit the terminal's variables).
  if (typeof flags.home === "string" && flags.home.trim()) process.env.COMPANY_BRAIN_HOME = resolve(flags.home.trim())
  // Self-hosted brain: trust its certificate before any call (hook and MCP included). The one from the command
  // (setup/init/join --ca) counts right away: on an old Node, this is where the process is restarted.
  const reexec = trustConfiguredCa(typeof flags.ca === "string" && flags.ca.trim() ? resolve(flags.ca.trim()) : loadPartialConfig().ca_file)
  if (reexec !== null) return reexec
  // The hook goes first: no stray output, always code 0.
  if (cmd === "hook") {
    const { runHook } = await import("./hook")
    return runHook()
  }
  // Diagnosis (doctor): which Node.js and which script this shortcut, this hook or this scheduled sync really runs.
  if (cmd === "_probe") {
    console.log(JSON.stringify({ version: VERSION, node: process.execPath, script: selfScript(), home: brainHome() }))
    return 0
  }
  if (flags.version || cmd === "version") {
    console.log(VERSION)
    return 0
  }
  if (!cmd || flags.help || cmd === "help") {
    console.log(help())
    return 0
  }
  switch (cmd) {
    case "setup": {
      const { cmdSetup } = await import("./setup")
      return cmdSetup(flags)
    }
    case "join": {
      const { cmdJoin } = await import("./join")
      return cmdJoin(flags)
    }
    case "init": {
      const { cmdInit } = await import("./commands")
      return cmdInit(flags)
    }
    case "hello": {
      const { cmdHello } = await import("./commands")
      return cmdHello()
    }
    case "status": {
      const { cmdStatus } = await import("./commands")
      return cmdStatus()
    }
    case "doctor": {
      const { cmdDoctor } = await import("./doctor")
      return cmdDoctor({ version: VERSION, json: Boolean(flags.json) })
    }
    case "sync": {
      const { runSync } = await import("./sync")
      const source = typeof flags.source === "string" ? flags.source : "all"
      if (source !== "all" && !(SOURCE_NAMES as readonly string[]).includes(source)) throw new UserError(`Invalid --source: "${source}" (claude, codex, screenpipe or all).`)
      const limit = typeof flags.limit === "string" ? Number.parseInt(flags.limit, 10) : undefined
      if (limit !== undefined && !(limit > 0)) throw new UserError("--limit must be a positive integer.")
      const distiller = typeof flags.distiller === "string" ? flags.distiller : undefined
      if (distiller && !["heuristic", "claude-cli", "claude-api"].includes(distiller)) throw new UserError("--distiller: heuristic, claude-cli or claude-api.")
      if (flags.confirm && flags["dry-run"]) throw new UserError("--confirm and --dry-run are mutually exclusive: do a dry run first, then confirm.")
      // Scheduled sync: PATH and folders recorded at install time (cron, launchd and Windows start from a minimal environment).
      if (flags.scheduled) applyScheduleEnv(loadPartialConfig())
      const startedAt = Date.now()
      let summary: SyncSummary | null = null
      try {
        summary = await runSync({
          dryRun: Boolean(flags["dry-run"]),
          since: typeof flags.since === "string" ? flags.since : undefined,
          source: source as SourceName | "all",
          limit,
          verbose: Boolean(flags.verbose),
          distiller: distiller as DistillerKind | undefined,
          reset: Boolean(flags.reset),
          full: Boolean(flags.full),
          confirm: Boolean(flags.confirm),
        })
      } catch (err) {
        // A failed sync is reported to the brain (Monitoring page), then the error goes on its way.
        if (!flags["dry-run"]) await sendReport({ summary: null, startedAt, error: err })
        throw err
      }
      // Dry run and skipped sync (lock): nothing to report.
      if (!flags["dry-run"] && !summary.skipped) await sendReport({ summary, startedAt })
      // The skills assigned to the computer follow the same pace as the sync (dry runs excepted).
      if (!flags["dry-run"]) {
        const { refreshSkills } = await import("./skills")
        await refreshSkills(console.log, { quiet: true })
      }
      return 0
    }
    case "skills": {
      const { cmdSkills } = await import("./skills")
      return cmdSkills(positional, flags)
    }
    case "refresh-status": {
      const { cmdRefreshStatus } = await import("./refresh-status")
      return cmdRefreshStatus({ dryRun: Boolean(flags["dry-run"]), verbose: Boolean(flags.verbose) })
    }
    case "refresh-zones": {
      const { cmdRefreshZones } = await import("./refresh-zones")
      return cmdRefreshZones({ dryRun: Boolean(flags["dry-run"]) })
    }
    case "mcp": {
      const { runMcpServer } = await import("./mcp")
      await runMcpServer(VERSION)
      return -1 // the server stays up
    }
    case "install-hooks": {
      const { installHooks } = await import("./install")
      installHooks()
      return 0
    }
    case "install-schedule": {
      const { installSchedule } = await import("./install")
      return installSchedule() ? 0 : 1
    }
    case "install-pipe": {
      const { installPipe } = await import("./install")
      installPipe()
      return 0
    }
    case "uninstall": {
      const { uninstall } = await import("./install")
      uninstall({ purge: Boolean(flags.purge) })
      return 0
    }
    default:
      console.error(`Unknown command: "${cmd}".\n`)
      console.log(help())
      return 2
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code
  },
  (err) => {
    if (process.argv[2] === "hook") process.exit(0)
    console.error(err instanceof UserError ? err.message : `Error: ${(err as Error)?.message ?? err}`)
    if (process.env.COMPANY_BRAIN_DEBUG && err instanceof Error) console.error(err.stack)
    process.exitCode = 1
  },
)
