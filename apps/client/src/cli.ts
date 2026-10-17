// brain.mjs — client du cerveau d'entreprise sur le poste de l'employé.

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
  return `NOS Brainer — client du poste (v${VERSION})

Usage : ${me} <commande> [options]

Commandes :
  setup [--url <url> --token <jeton>] [--ca <pem>] [--audio oui|non] [--wait <secondes>] [--no-open] [--skip-screenpipe]
                     Tout en une commande (c'est ce que lance le prompt d'installation) : config, Screenpipe (installé et lancé
                     en service s'il ne tourne pas, micro coupé par défaut), autorisations macOS (réglages ouverts, reprise dès
                     qu'elles sont accordées, --wait 300 s par défaut), MCP, hooks, synchro toutes les 15 min (activité à venir
                     seulement), néon, puis le cerveau s'ouvre dans le navigateur. Relançable sans paramètres.
                     Codes de sortie : 0 tout est branché ; 3 tout sauf l'autorisation d'enregistrer l'écran (relancer setup une
                     fois cochée) ; 6 tout sauf Screenpipe (pas de version pour ce poste, ou il ne démarre pas : voir doctor).
  join --url <url> --join <code d'équipe> [--name <prénom nom>] [--title <poste>] [--email <email>] [--wait-accept <secondes>]
                     Demande à rejoindre une entreprise (c'est ce que lance le message d'équipe) : le jeton du poste est créé
                     ici, seule son empreinte part avec la demande. Attend qu'un admin l'accepte (--wait-accept 480 s par
                     défaut), puis enchaîne sur setup (mêmes options, mêmes codes). Code 7 : toujours en attente, \`join\` sans
                     paramètres reprend la même demande. Code 8 : demande refusée.
  doctor [--json]    Diagnostic du poste, sans rien modifier : Node.js, raccourci, cerveau (connexion, version du client),
                     Screenpipe (capture, autorisations, jeton), Claude Code (MCP, hooks), synchro planifiée, distillation.
                     Chaque point KO donne la commande qui répare. --json : le même rapport pour Claude Code (champ « safe »
                     sur les commandes qui ne font que rebrancher le poste). Code de sortie 1 s'il reste un point KO.
  init --url <url> --token <jeton> [--screenpipe-url <u>] [--screenpipe-token <t>] [--anthropic-key <k>]
       [--claude-token <jeton>] [--share-prompt-summaries oui|non] [--screenpipe-meetings oui|non] [--ca <pem>]
                     Enregistre la config (~/.company-brain/config.json, mode 600) et teste la connexion.
                     --ca : certificat (PEM) de l'autorité d'un cerveau auto-hébergé en HTTPS local ; le client lui fait
                     confiance pour tous ses appels, en plus des certificats publics (« aucun » pour le retirer).
                     Chaque option peut être donnée seule pour compléter une config existante.
                     --claude-token : jeton longue durée créé par \`claude setup-token\` (abonnement Claude, sans clé API),
                     passé à chaque \`claude -p\` du client, synchro planifiée comprise (« aucun » pour le retirer).
                     --share-prompt-summaries non : le hook n'envoie plus aucun résumé de prompt (empreinte seule).
                     --screenpipe-meetings non : les réunions transcrites par Screenpipe ne sont pas distillées.
  hello              Test de bout en bout : vos zones s'allument sur le dashboard.
  sync [--dry-run [--full]] [--since 24h|7d|<ISO>] [--source claude|codex|screenpipe|all] [--limit N] [--verbose]
                     Lit les sessions IA locales, filtre (secrets, perso), distille et envoie au cerveau.
                     --dry-run montre ce qui partirait sans rien envoyer (--full : chaque connaissance en entier),
                     et dit ce que l'aperçu ne contient pas (limite atteinte, captures non lues, tours en cours).
                     Si Claude échoue, la conversation est retentée plus tard (jamais distillée sans LLM en secours),
                     et abandonnée après 3 échecs dus à son contenu ; une panne, une limite d'abonnement ou un
                     jeton expiré ne compte pas (si Claude ne répond plus du tout : abandon après 24 h d'échecs).
                     À la fin (hors simulation), un compte rendu (compteurs seulement, jamais de contenu) part vers la page
                     Supervision du dashboard : dernière synchro, durée, erreurs.
  sync --confirm     Envoie exactement ce que la dernière simulation a montré (valable 24 h).
                     Options avancées : --distiller heuristic|claude-cli|claude-api, --reset (ignore les checkpoints).
  skills [sync|list] Installe dans ~/.claude/skills les skills de l'entreprise attribués à ce poste (toute l'entreprise, plus
                     ceux des cortex que vous lisez) et retire ceux qui ne le sont plus. Fait aussi après chaque synchro.
                     Un skill personnel du même nom n'est jamais touché. list : affiche sans rien installer.
  skills push <dossier> [--cortex <zone>|entreprise] [--name <nom>] [--description <texte>]
                     Publie le dossier (SKILL.md et les scripts qu'il utilise) dans le cerveau ; même nom : version suivante.
                     Demande le droit de publier des skills (accordé par un admin). Sans --cortex : celui de la version
                     précédente, ou toute l'entreprise pour un nouveau skill. Un fichier qui contient un secret est refusé.
  refresh-status [--dry-run]
                     Admins : rédige « où en est la boîte » sur ce poste avec Claude (\`claude -p\`, votre abonnement ;
                     sinon la clé API) et l'envoie au dashboard. --dry-run : affiche le résumé sans l'envoyer.
  refresh-zones [--dry-run]
                     Admins : passage « nouvelles zones » fait ici par Claude Code (\`claude -p\`, votre abonnement ;
                     en CI, CLAUDE_CODE_OAUTH_TOKEN de \`claude setup-token\`). Le cerveau crée les zones qui manquent
                     et y range leurs connaissances. --dry-run : affiche les propositions sans rien envoyer.
  status             État du client en bref : connexion, dernière synchro, Screenpipe, hooks, planification (détail : doctor).
  mcp                Serveur MCP stdio « company-brain » (branché par setup dans Claude Code, portée utilisateur).
  hook               Gestionnaire des hooks Claude Code (lit le JSON du hook sur l'entrée standard).
  install-hooks      Ajoute les hooks SessionStart, UserPromptSubmit et Stop à ~/.claude/settings.json.
  install-schedule   Planifie « sync » toutes les 15 min (launchd, crontab ou tâche Windows), à partir de maintenant pour
                     toutes les sources (Screenpipe, Claude Code, Codex) : l'historique non relu n'est jamais envoyé
                     automatiquement. À lancer après sync --confirm.
  install-pipe       Écrit le pipe Screenpipe « brain-sync » (~/.screenpipe/pipes/brain-sync/pipe.md) : la synchro apparaît dans les tâches
                     planifiées de Screenpipe et se relance à la fin de chaque réunion. Demande l'application Screenpipe (moteur de pipes).
  uninstall [--purge] Prévient le cerveau (poste noté désinstallé, jeton révoqué), puis retire hooks, planification, pipe Screenpipe, MCP,
                     skills de l'entreprise et le service Screenpipe installé par setup ; --purge supprime aussi ~/.company-brain.

Variables : COMPANY_BRAIN_HOME (défaut ~/.company-brain, ou --home <dossier>), CLAUDE_CONFIG_DIR (défaut ~/.claude), CODEX_HOME (défaut ~/.codex).`
}

/** Compte rendu de synchro envoyé au cerveau ; un échec de l'envoi n'est jamais bloquant. */
async function sendReport(input: { summary: SyncSummary | null; startedAt: number; error?: unknown }) {
  try {
    const { buildSyncReport } = await import("./report")
    const { BrainApi } = await import("./api")
    const cfg = loadPartialConfig()
    if (!cfg.url || !cfg.token) return
    await new BrainApi(cfg.url, cfg.token).report(buildSyncReport({ ...input, version: VERSION }))
  } catch (err) {
    if (process.env.COMPANY_BRAIN_DEBUG) console.error(`Compte rendu non envoyé : ${(err as Error)?.message ?? err}`)
  }
}

async function main(argv: string[]): Promise<number> {
  const { cmd, flags, positional } = parseArgs(argv)
  // --home : dossier du client (utilisé par la tâche planifiée Windows, qui n'hérite pas des variables du terminal).
  if (typeof flags.home === "string" && flags.home.trim()) process.env.COMPANY_BRAIN_HOME = resolve(flags.home.trim())
  // Cerveau auto-hébergé : confiance à son certificat avant tout appel (hook et MCP compris). Celui de la commande
  // (setup/init/join --ca) compte dès maintenant : sur un Node ancien, c'est ici que le processus est relancé.
  const reexec = trustConfiguredCa(typeof flags.ca === "string" && flags.ca.trim() ? resolve(flags.ca.trim()) : loadPartialConfig().ca_file)
  if (reexec !== null) return reexec
  // Le hook passe en premier : aucune sortie parasite, toujours code 0.
  if (cmd === "hook") {
    const { runHook } = await import("./hook")
    return runHook()
  }
  // Diagnostic (doctor) : quel Node.js et quel script ce raccourci, ce hook ou cette synchro planifiée lancent vraiment.
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
      if (source !== "all" && !(SOURCE_NAMES as readonly string[]).includes(source)) throw new UserError(`--source invalide : « ${source} » (claude, codex, screenpipe ou all).`)
      const limit = typeof flags.limit === "string" ? Number.parseInt(flags.limit, 10) : undefined
      if (limit !== undefined && !(limit > 0)) throw new UserError("--limit doit être un entier positif.")
      const distiller = typeof flags.distiller === "string" ? flags.distiller : undefined
      if (distiller && !["heuristic", "claude-cli", "claude-api"].includes(distiller)) throw new UserError("--distiller : heuristic, claude-cli ou claude-api.")
      if (flags.confirm && flags["dry-run"]) throw new UserError("--confirm et --dry-run s'excluent : simulez d'abord, puis confirmez.")
      // Synchro planifiée : PATH et dossiers relevés à l'installation (cron, launchd et Windows partent d'un environnement minimal).
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
        // Une synchro en échec est signalée au cerveau (page Supervision), puis l'erreur suit son cours.
        if (!flags["dry-run"]) await sendReport({ summary: null, startedAt, error: err })
        throw err
      }
      // Simulation et synchro sautée (verrou) : rien à rapporter.
      if (!flags["dry-run"] && !summary.skipped) await sendReport({ summary, startedAt })
      // Les skills attribués au poste suivent la même cadence que la synchro (simulation exceptée).
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
    case "install-pipe": {
      const { installPipe } = await import("./install")
      installPipe()
      return 0
    }
    case "uninstall": {
      const { uninstall } = await import("./install")
      await uninstall({ purge: Boolean(flags.purge) })
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
