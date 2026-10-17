// `connect-claude` : le jeton Claude Code longue durée du poste, demandé à l'installation. `claude setup-token` ouvre la
// connexion dans le navigateur et affiche le jeton ; on le colle ici (saisie masquée), il est essayé puis rangé dans
// config.json (mode 600). La synchro planifiée (toutes les 15 min, sans session ouverte) le passe à chaque `claude -p` :
// distillation, agent Screenpipe et, sur le poste d'un admin, modérateur. Il ne quitte jamais le poste.

import { spawnSync } from "node:child_process"
import { createInterface } from "node:readline"
import { UserError, loadPartialConfig, maskSecret, saveConfig } from "./config"
import { claudeAuthHelp, cliFailure, findOnPath, runClaudeCli, spawnTarget } from "./distill"

type Log = (s: string) => void

/** Un jeton de `claude setup-token` (sk-ant-oat01-…). */
export const CLAUDE_TOKEN_RE = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,300}$/

/** Saisie masquée dans le terminal (rien n'est affiché pendant qu'on colle). */
function readHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const out = rl as unknown as { _writeToOutput: (s: string) => void }
    out._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(s)
    }
    rl.question(question, (answer) => {
      process.stdout.write("\n")
      rl.close()
      resolve(answer.trim())
    })
  })
}

export type ConnectDeps = {
  isTTY?: boolean
  claudePath?: string | null
  /** Lance `claude setup-token` dans le terminal (connexion dans le navigateur). */
  runSetupToken?: (claudePath: string) => boolean
  readToken?: () => Promise<string>
}

/** Vrai si le poste a déjà de quoi faire tourner Claude sans session ouverte (jeton enregistré, ou clé API). */
export function hasScheduledClaude(cfg = loadPartialConfig()): boolean {
  return Boolean(cfg.claude_oauth_token || cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY)
}

/** `brain.mjs connect-claude` : jeton Claude Code du poste, demandé une fois, essayé, enregistré. Code 0 si enregistré. */
export async function cmdConnectClaude(log: Log = console.log, deps: ConnectDeps = {}): Promise<number> {
  const claudePath = deps.claudePath !== undefined ? deps.claudePath : findOnPath("claude")
  if (!claudePath) throw new UserError("CLI `claude` introuvable : installez Claude Code (`npm install -g @anthropic-ai/claude-code`), puis relancez connect-claude.")
  if (!(deps.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY))) {
    throw new UserError("connect-claude se lance dans un terminal : connexion à Claude dans le navigateur, puis on colle le jeton affiché.")
  }
  log("Connexion à Claude : le navigateur va s'ouvrir. Une fois connecté, copiez le jeton affiché (sk-ant-oat01-…).")
  const ran = (
    deps.runSetupToken ??
    ((p) => {
      const t = spawnTarget(p, ["setup-token"])
      return spawnSync(t.cmd, t.args, { stdio: "inherit", shell: t.shell }).status === 0
    })
  )(claudePath)
  if (!ran) log("`claude setup-token` ne s'est pas terminé normalement : si un jeton s'est affiché, collez-le quand même.")
  const token = await (deps.readToken ?? (() => readHidden("Collez le jeton ici (rien ne s'affiche) : ")))()
  if (!CLAUDE_TOKEN_RE.test(token)) throw new UserError("Ce n'est pas un jeton de `claude setup-token` (il commence par « sk-ant-oat »). Relancez connect-claude.")

  log("Essai du jeton…")
  const run = await runClaudeCli(claudePath, "Réponds seulement OK.", 60_000, { oauthToken: token })
  const fail = cliFailure(run)
  if (fail?.failure === "auth") throw new UserError(`${claudeAuthHelp(fail.error)} Le jeton n'a pas été enregistré.`)
  if (fail) log(`Claude n'a pas pu être joint pour l'essai (${fail.error}) : le jeton est enregistré quand même.`)

  saveConfig({ ...loadPartialConfig(), claude_oauth_token: token })
  log(`Jeton Claude Code enregistré (${maskSecret(token)}) : la synchro des 15 min s'en sert, même sans session ouverte. Il reste sur ce poste.`)
  return 0
}
