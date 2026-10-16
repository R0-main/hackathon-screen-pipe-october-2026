// brain.mjs — client du cerveau d'entreprise sur le poste de l'employé.

import { SOURCE_NAMES, UserError, selfScript, type SourceName } from "./config"
import type { DistillerKind } from "./distill"

const VERSION = "0.1.0"
const BOOLEAN_FLAGS = new Set(["dry-run", "verbose", "purge", "help", "reset", "version"])

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
  const me = `node ${selfScript()}`
  return `Cerveau d'entreprise — client du poste (v${VERSION})

Usage : ${me} <commande> [options]

Commandes :
  init --url <url> --token <jeton> [--screenpipe-url <u>] [--screenpipe-token <t>] [--anthropic-key <k>]
                     Enregistre la config (~/.company-brain/config.json, mode 600) et teste la connexion.
                     Chaque option peut être donnée seule pour compléter une config existante.
  hello              Test de bout en bout : vos zones s'allument sur le dashboard.
  sync [--dry-run] [--since 24h|7d|<ISO>] [--source claude|codex|screenpipe|all] [--limit N] [--verbose]
                     Lit les sessions IA locales, filtre (secrets, perso), distille et envoie au cerveau.
                     Options avancées : --distiller heuristic|claude-cli|claude-api, --reset (ignore les checkpoints).
  status             État du client : connexion, dernière synchro, Screenpipe, hooks, planification.
  mcp                Serveur MCP stdio « company-brain » (à brancher avec : claude mcp add company-brain --scope user -- node ${selfScript()} mcp).
  hook               Gestionnaire des hooks Claude Code (lit le JSON du hook sur l'entrée standard).
  install-hooks      Ajoute les hooks SessionStart, UserPromptSubmit et Stop à ~/.claude/settings.json.
  install-schedule   Planifie « sync » toutes les 15 min (launchd, crontab ou tâche Windows).
  uninstall [--purge] Retire hooks, planification et MCP ; --purge supprime aussi ~/.company-brain.

Variables : COMPANY_BRAIN_HOME (défaut ~/.company-brain), CLAUDE_CONFIG_DIR (défaut ~/.claude), CODEX_HOME (défaut ~/.codex).`
}

async function main(argv: string[]): Promise<number> {
  const { cmd, flags } = parseArgs(argv)
  // Le hook passe en premier : aucune sortie parasite, toujours code 0.
  if (cmd === "hook") {
    const { runHook } = await import("./hook")
    return runHook()
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
    case "sync": {
      const { runSync } = await import("./sync")
      const source = typeof flags.source === "string" ? flags.source : "all"
      if (source !== "all" && !(SOURCE_NAMES as readonly string[]).includes(source)) throw new UserError(`--source invalide : « ${source} » (claude, codex, screenpipe ou all).`)
      const limit = typeof flags.limit === "string" ? Number.parseInt(flags.limit, 10) : undefined
      if (limit !== undefined && !(limit > 0)) throw new UserError("--limit doit être un entier positif.")
      const distiller = typeof flags.distiller === "string" ? flags.distiller : undefined
      if (distiller && !["heuristic", "claude-cli", "claude-api"].includes(distiller)) throw new UserError("--distiller : heuristic, claude-cli ou claude-api.")
      await runSync({
        dryRun: Boolean(flags["dry-run"]),
        since: typeof flags.since === "string" ? flags.since : undefined,
        source: source as SourceName | "all",
        limit,
        verbose: Boolean(flags.verbose),
        distiller: distiller as DistillerKind | undefined,
        reset: Boolean(flags.reset),
      })
      return 0
    }
    case "mcp": {
      const { runMcpServer } = await import("./mcp")
      await runMcpServer(VERSION)
      return -1 // le serveur reste actif
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
    case "uninstall": {
      const { uninstall } = await import("./install")
      uninstall({ purge: Boolean(flags.purge) })
      return 0
    }
    default:
      console.error(`Commande inconnue : « ${cmd} ».\n`)
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
    console.error(err instanceof UserError ? err.message : `Erreur : ${(err as Error)?.message ?? err}`)
    if (process.env.COMPANY_BRAIN_DEBUG && err instanceof Error) console.error(err.stack)
    process.exitCode = 1
  },
)
