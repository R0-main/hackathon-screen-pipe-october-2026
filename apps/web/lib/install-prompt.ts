// Le « prompt magique » de NOS Brainer : l'employé le colle dans Claude Code (ou Codex), qui lance UNE commande (celle de
// son système), lit son code de sortie et dépanne avec `brain doctor` si besoin. Tout le travail est dans notre CLI
// (docs/CLI.md) : `install.sh` (macOS, Linux, Git Bash) ou `install.ps1` (Windows) trouve ou installe Node.js, télécharge
// `brain.mjs` et lance `brain setup`, qui installe Screenpipe, ouvre les bons Réglages macOS, branche le MCP et les hooks,
// planifie la synchro et ouvre le cerveau déjà connecté. Aucun historique n'est envoyé : la synchro part de
// l'installation ; relire puis envoyer ses dernières 24 h reste une option proposée à la fin.
// La première phrase est reconnue par brain-sync (INSTALL_PROMPT_RE, apps/client/src/secrets.ts) : cette session contient
// le jeton en clair et n'est jamais envoyée au cerveau. Ne pas la reformuler sans mettre à jour le client.
//
// Codes de sortie, les mêmes pour install.sh, install.ps1, `brain setup` et `brain join` (docs/CLI.md) : 0 tout est
// branché ; 1 échec (→ doctor) ; 2 mauvais appel ; 3 autorisation macOS en attente ; 4 système non géré ; 5 téléchargement
// impossible ; 6 branché sans Screenpipe ; 7 demande pas encore acceptée ; 8 demande refusée.

/**
 * Nos prompts n'ont de sens que sur le poste de la personne (installer le client, lire son historique). Une session
 * Claude Code dans le cloud (app de bureau en environnement distant) s'arrête au lieu d'installer dans un conteneur.
 */
export const LOCAL_ONLY = "Si tu ne tournes pas sur mon poste (session cloud, conteneur distant), arrête-toi et dis-moi de recoller ce message dans Claude Code ou Codex en local (terminal `claude` ou `codex`)."

/** Le raccourci écrit par install.sh : marche même quand Node.js est une copie privée hors du PATH. */
export const BRAIN_CLI = "~/.company-brain/brain"
/** Sous Windows (PowerShell comme Git Bash) : le raccourci écrit par install.ps1. */
export const BRAIN_CLI_WINDOWS = "~/.company-brain/brain.cmd"

/** Codes de sortie cités par les prompts (voir l'en-tête). */
export const EXIT = { permissions: 3, download: 5, noScreenpipe: 6, joinPending: 7, joinRejected: 8 } as const

/**
 * La commande unique de chaque système, suivie des options (`--token …` ou `--join …`, seul endroit où le jeton ou le
 * code apparaît). Un téléchargement raté rend 5 (jamais le code brut de curl, qui se confondrait avec les nôtres :
 * « curl: (6) » serait lu comme « branché sans Screenpipe ») ; sous Windows, `exit $LASTEXITCODE` rend le code de setup
 * même quand la ligne est passée à `powershell -Command`.
 */
export function installCommands(baseUrl: string, options = "", caFingerprint?: string): { posix: string; windows: string | null } {
  const dir = '"$env:USERPROFILE\\.company-brain'
  const args = `--url ${baseUrl}${options ? ` ${options}` : ""}`
  if (caFingerprint) {
    // Cerveau auto-hébergé en HTTPS local : son certificat est d'abord récupéré (sans vérification, il n'y a encore rien
    // pour le vérifier), puis contrôlé par son empreinte SHA-256 donnée ici ; tout le reste passe par lui. Windows :
    // install.ps1 ne connaît pas encore le certificat privé.
    const check = `[ "$(openssl x509 -in ${CA_FILE} -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)" = "${caFingerprint}" ]`
    return {
      posix:
        `mkdir -p ~/.company-brain && (curl -ksSL ${baseUrl}/ca.crt -o ${CA_FILE} || exit ${EXIT.download}) && ${check} && ` +
        `(curl -fsSL --cacert ${CA_FILE} ${baseUrl}/install.sh -o ~/.company-brain/install.sh || exit ${EXIT.download}) && sh ~/.company-brain/install.sh ${args} --ca ${CA_FILE}`,
      windows: null,
    }
  }
  return {
    posix: `(curl -fsSL --create-dirs ${baseUrl}/install.sh -o ~/.company-brain/install.sh || exit ${EXIT.download}) && sh ~/.company-brain/install.sh ${args}`,
    windows:
      `New-Item -ItemType Directory -Force ${dir}" | Out-Null; ` +
      `try { Invoke-WebRequest -UseBasicParsing ${baseUrl}/install.ps1 -OutFile ${dir}\\install.ps1" -ErrorAction Stop } catch { exit ${EXIT.download} }; ` +
      `powershell -NoProfile -ExecutionPolicy Bypass -File ${dir}\\install.ps1" ${args}; exit $LASTEXITCODE`,
  }
}

/** Les deux lignes « système : commande » du prompt ; sans commande Windows (certificat privé), une phrase le dit. */
function commandLines(cmd: { posix: string; windows: string | null }): string {
  return `   macOS, Linux, Git Bash : ${cmd.posix}\n` + (cmd.windows ? `   Windows, PowerShell : ${cmd.windows}` : "   Windows : pas encore pris en charge pour un cerveau auto-hébergé en HTTPS local (utilise un Mac ou Linux).")
}

/** Ce que Claude fait des codes communs (setup, et join une fois la demande acceptée). */
function commonCodes(brain: string): string {
  return (
    `Code ${EXIT.permissions} (« EN ATTENTE ») : redis-moi où cocher, puis relance \`${brain} setup\` (même délai). ` +
    `Code ${EXIT.download} : réseau ou adresse, relance la même commande. ` +
    `Autre code (${EXIT.noScreenpipe} : branché sans Screenpipe) : lance \`${brain} doctor --json\`, explique simplement chaque point KO et lance les corrections marquées « safe » (même délai). ` +
    `Sous Windows, le client est \`${BRAIN_CLI_WINDOWS}\`.`
  )
}

/** Où install.sh et le client gardent le certificat d'un cerveau auto-hébergé. */
export const CA_FILE = "~/.company-brain/ca.crt"

const CA_NOTE = "   (cerveau auto-hébergé en HTTPS local : la commande récupère son certificat et vérifie son empreinte avant de s'en servir ; si cette vérification échoue, arrête-toi et préviens-moi.)\n"

/** « de Fournil », « d'Atelier Lumen » : l'élision devant une voyelle ou un h. */
export function deNom(name: string): string {
  return /^[aeiouyhàâäéèêëîïôöùûüœæ]/i.test(name.trim()) ? `d'${name.trim()}` : `de ${name.trim()}`
}

export function buildInstallPrompt(opts: { baseUrl: string; token: string; name: string; orgName: string; zones: string[]; caFingerprint?: string }): string {
  const { baseUrl, token, name, orgName, zones, caFingerprint } = opts
  const brain = BRAIN_CLI
  const cmd = installCommands(baseUrl, `--token ${token}`, caFingerprint)
  return `Tu vas connecter ce poste à NOS Brainer, le cerveau d'entreprise ${deNom(orgName)}. Je suis ${name}, zones : ${zones.join(", ") || "aucune pour l'instant"}.
Ce message contient mon jeton personnel : ne l'affiche jamais en entier (brain-sync reconnaît cette conversation et ne l'envoie jamais au cerveau). Sois bref. ${LOCAL_ONLY}

1. Préviens-moi en une phrase : sur Mac, les Réglages Système vont s'ouvrir et je devrai activer « screenpipe » dans « Enregistrement de l'écran » puis dans « Accessibilité » ; la commande attend et reprend toute seule.
2. Lance la commande de mon système telle quelle, en un seul appel, avec un délai de 10 minutes (hors du bac à sable si elle y est bloquée) :
${commandLines(cmd)}
${caFingerprint ? CA_NOTE : ""}3. Code 0 : c'est fini, le cerveau s'est ouvert dans mon navigateur. ${commonCodes(brain)}
4. Termine en trois lignes : ce qui tourne, ce qui part (des connaissances distillées, jamais l'écran brut ; aucun historique n'est envoyé) et comment tout retirer (\`${brain} uninstall\`). Propose enfin de faire apprendre au cerveau mes dernières 24 h : montre-moi d'abord \`${brain} sync --dry-run --full --since 24h\` en entier ; rien ne part avant mon accord explicite, puis \`${brain} sync --confirm\` envoie exactement ce que j'ai relu.`
}

// Le message d'équipe : le même pour toute l'entreprise, à envoyer à ses collègues (jamais publiquement). Il ne donne
// accès à rien : la commande crée une demande, préremplie par le Claude du demandeur, qu'un admin accepte ou refuse.
// Le jeton est généré sur le poste et seule son empreinte part avec la demande ; une fois acceptée, `brain join`
// enchaîne sur `setup`. Première phrase reconnue par brain-sync (INSTALL_PROMPT_RE) : ne pas la reformuler seule.

/** Codes de sortie propres à `brain join` (apps/client/src/join.ts). */
export const JOIN_EXIT = { pending: EXIT.joinPending, rejected: EXIT.joinRejected } as const

export function buildJoinPrompt(opts: { baseUrl: string; code: string; orgName: string; caFingerprint?: string }): string {
  const { baseUrl, code, orgName, caFingerprint } = opts
  const org = deNom(orgName)
  const brain = BRAIN_CLI
  const cmd = installCommands(baseUrl, `--join ${code} --name "<prénom nom>" --title "<poste>" --email "<email>"`, caFingerprint)
  return `Tu vas demander à rejoindre NOS Brainer, le cerveau d'entreprise ${org}. Ce message d'équipe contient le code d'accès ${org} : ne l'affiche jamais en entier et ne le transmets pas hors de l'entreprise (brain-sync reconnaît cette conversation et ne l'envoie jamais au cerveau). Sois bref. ${LOCAL_ONLY}

1. Sans me poser de question, prépare ma demande avec ce que tu sais déjà de moi : prénom et nom (\`git config user.name\`, nom du compte de la machine), poste ou métier (ta mémoire, CLAUDE.md ou AGENTS.md, nos échanges), email pro (\`git config user.email\`). N'invente rien : une valeur que tu n'as pas, retire son option, un admin la complétera.
2. Préviens-moi en une phrase : un admin ${org} doit accepter ma demande ; la commande l'attend, puis installe tout (sur Mac, il faudra activer « screenpipe » dans « Enregistrement de l'écran » puis dans « Accessibilité »).
3. Lance la commande de mon système en un seul appel, avec un délai de 10 minutes (hors du bac à sable si elle y est bloquée), en remplaçant les valeurs entre chevrons :
${commandLines(cmd)}
${caFingerprint ? CA_NOTE : ""}4. Code 0 : demande acceptée et poste branché, le cerveau s'est ouvert dans mon navigateur. Code ${JOIN_EXIT.pending} (« EN ATTENTE D'ACCEPTATION ») : dis-moi que ma demande attend un admin et propose de relancer \`${brain} join\`, qui reprend la même demande. Code ${JOIN_EXIT.rejected} : la demande a été refusée, rien n'est installé. ${commonCodes(brain)}
5. Termine en trois lignes : ce qui tourne, ce qui part (des connaissances distillées, jamais l'écran brut ; aucun historique n'est envoyé) et comment tout retirer (\`${brain} uninstall\`).`
}
