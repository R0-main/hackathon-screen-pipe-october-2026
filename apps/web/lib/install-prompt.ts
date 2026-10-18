// NOS Brainer's "magic prompt": the employee pastes it into Claude Code (or Codex), which runs ONE command (the one for
// their system), reads its exit code and troubleshoots with `brain doctor` if needed. All the work is in our CLI
// (docs/CLI.md): `install.sh` (macOS, Linux, Git Bash) or `install.ps1` (Windows) finds or installs Node.js, downloads
// `brain.mjs` and runs `brain setup`, which installs Screenpipe, opens the right macOS Settings, connects the MCP and the
// hooks, schedules the sync and opens the brain already signed in. No history is sent: the sync starts from the
// install; reviewing then sending the last 24 h stays an option offered at the end.
// The first sentence is recognized by brain-sync (INSTALL_PROMPT_RE, apps/client/src/secrets.ts): this session contains
// the token in clear and is never sent to the brain. Do not rephrase it without updating the client.
//
// Exit codes, the same for install.sh, install.ps1, `brain setup` and `brain join` (docs/CLI.md): 0 everything is
// connected; 1 failure (→ doctor); 2 bad call; 3 macOS permission pending; 4 unsupported system; 5 download
// failed; 6 connected without Screenpipe; 7 request not accepted yet; 8 request declined.

import { isCoreZone } from "@brain/core"

/**
 * Our prompts only make sense on the person's own workstation (installing the client, reading their history). A Claude
 * Code session in the cloud (desktop app in a remote environment) stops instead of installing into a container.
 */
export const LOCAL_ONLY = "If you are not running on my computer (cloud session, remote container), stop and tell me in one sentence to paste this message again into Claude Code or Codex locally (the `claude` or `codex` terminal)."

/** An action refused (permission mode, sandbox): one sentence that says what to do, not a list of reasons or options. */
export const IF_BLOCKED = "Action blocked or refused: work around nothing, tell me in one sentence what to do, with no list or explanation, then wait."

/** The shortcut written by install.sh: works even when Node.js is a private copy outside the PATH. */
export const BRAIN_CLI = "~/.company-brain/brain"
/** On Windows (PowerShell as well as Git Bash): the shortcut written by install.ps1. */
export const BRAIN_CLI_WINDOWS = "~/.company-brain/brain.cmd"

/** Exit codes cited by the prompts (see the header). */
export const EXIT = { permissions: 3, download: 5, noScreenpipe: 6, joinPending: 7, joinRejected: 8, certificate: 9 } as const

/**
 * The single command for each system, followed by the options (`--token …` or `--join …`, the only place where the token
 * or the code appears). A failed download returns 5 (never curl's raw code, which would be confused with ours:
 * "curl: (6)" would read as "connected without Screenpipe"); on Windows, `exit $LASTEXITCODE` returns setup's code
 * even when the line is passed to `powershell -Command`.
 */
export function installCommands(baseUrl: string, options = "", caFingerprint?: string): { posix: string; windows: string } {
  const dir = '"$env:USERPROFILE\\.company-brain'
  const args = `--url ${baseUrl}${options ? ` ${options}` : ""}`
  const ps1 = `try { Invoke-WebRequest -UseBasicParsing ${baseUrl}/install.ps1 -OutFile ${dir}\\install.ps1" -ErrorAction Stop } catch { exit ${EXIT.download} }; `
  if (caFingerprint) {
    // Self-hosted brain over local HTTPS: its certificate is fetched first (without verification, there is nothing yet
    // to verify it with), then checked against its SHA-256 fingerprint given here (9 if it differs); everything else goes
    // through it. On Windows, it is added to the user's trusted certificates (browsers and downloads;
    // Windows asks for confirmation), then install.ps1 and the client receive --ca.
    const check = `[ "$(openssl x509 -in ${CA_FILE} -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)" = "${caFingerprint}" ]`
    return {
      posix:
        `mkdir -p ~/.company-brain && (curl -ksSL ${baseUrl}/ca.crt -o ${CA_FILE} || exit ${EXIT.download}) && (${check} || exit ${EXIT.certificate}) && ` +
        `(curl -fsSL --cacert ${CA_FILE} ${baseUrl}/install.sh -o ~/.company-brain/install.sh || exit ${EXIT.download}) && sh ~/.company-brain/install.sh ${args} --ca ${CA_FILE}`,
      windows:
        `New-Item -ItemType Directory -Force ${dir}" | Out-Null; $ca = ${dir}\\ca.crt"; ` +
        `$skip = @{}; if ($PSVersionTable.PSVersion.Major -ge 6) { $skip = @{ SkipCertificateCheck = $true } } else { [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } }; ` +
        `try { Invoke-WebRequest -UseBasicParsing ${baseUrl}/ca.crt -OutFile $ca -ErrorAction Stop @skip } catch { exit ${EXIT.download} }; ` +
        `[Net.ServicePointManager]::ServerCertificateValidationCallback = $null; ` +
        `$c = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $ca; ` +
        `if (([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData)) -replace '-') -ne '${caFingerprint}') { exit ${EXIT.certificate} }; ` +
        `if (-not (Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object Thumbprint -eq $c.Thumbprint)) { certutil -user -addstore Root $ca | Out-Null }; ` +
        ps1 +
        `powershell -NoProfile -ExecutionPolicy Bypass -File ${dir}\\install.ps1" ${args} --ca $ca; exit $LASTEXITCODE`,
    }
  }
  return {
    posix: `(curl -fsSL --create-dirs ${baseUrl}/install.sh -o ~/.company-brain/install.sh || exit ${EXIT.download}) && sh ~/.company-brain/install.sh ${args}`,
    windows: `New-Item -ItemType Directory -Force ${dir}" | Out-Null; ` + ps1 + `powershell -NoProfile -ExecutionPolicy Bypass -File ${dir}\\install.ps1" ${args}; exit $LASTEXITCODE`,
  }
}

/**
 * Rerunning the install from an already connected workstation (brain doctor): the config keeps the token, and a
 * self-hosted brain's certificate is already on the workstation (added to the Windows store at the first install).
 */
export function reinstallCommands(baseUrl: string, caFile?: string): { posix: string; windows: string } {
  if (!caFile) return installCommands(baseUrl)
  const dir = '"$env:USERPROFILE\\.company-brain'
  const q = `"${caFile.replace(/"/g, '\\"')}"`
  return {
    posix: `(curl -fsSL --cacert ${q} --create-dirs ${baseUrl}/install.sh -o ~/.company-brain/install.sh || exit ${EXIT.download}) && sh ~/.company-brain/install.sh --url ${baseUrl} --ca ${q}`,
    windows:
      `New-Item -ItemType Directory -Force ${dir}" | Out-Null; ` +
      `try { Invoke-WebRequest -UseBasicParsing ${baseUrl}/install.ps1 -OutFile ${dir}\\install.ps1" -ErrorAction Stop } catch { exit ${EXIT.download} }; ` +
      `powershell -NoProfile -ExecutionPolicy Bypass -File ${dir}\\install.ps1" --url ${baseUrl} --ca ${q}; exit $LASTEXITCODE`,
  }
}

/** Start of the prompt's two "system: command" lines, read back by `terminalCommands`. */
const POSIX_LINE = "   macOS, Linux, Git Bash: "
const WINDOWS_LINE = "   Windows, PowerShell: "

/** The prompt's two "system: command" lines. */
function commandLines(cmd: { posix: string; windows: string }): string {
  return `${POSIX_LINE}${cmd.posix}\n${WINDOWS_LINE}${cmd.windows}`
}

/**
 * Without Claude Code or Codex: an install prompt's two commands, to paste yourself into a terminal (null for any
 * other prompt). The same install; only the agent's extras are left out, the review of the last 24 h included: the
 * brain learns from the install onward. macOS and Linux: as is, each `exit` is in a subshell. PowerShell: an `exit`
 * would close the window before the output can be read, so a failure says why and stops the line instead.
 */
export function terminalCommands(prompt: string): { posix: string; windows: string } | null {
  const lines = prompt.split("\n")
  const read = (start: string) => lines.find((l) => l.startsWith(start))?.slice(start.length)
  const posix = read(POSIX_LINE)
  const windows = read(WINDOWS_LINE)
  if (!posix || !windows || !posix.includes(" --token ")) return null
  const stop = (why: string) => `{ Write-Warning '${why}'; return }`
  return {
    posix,
    windows: windows
      .replace(/; exit \$LASTEXITCODE$/, "")
      .replaceAll(`{ exit ${EXIT.download} }`, stop("Download failed (network, proxy, brain address?): run the same command again."))
      .replaceAll(`{ exit ${EXIT.certificate} }`, stop("Unexpected brain certificate (fingerprint different from the one given): nothing was installed, tell your admin.")),
  }
}

/** What Claude does with the shared codes (setup, and join once the request is accepted). */
function commonCodes(brain: string): string {
  return (
    `Code ${EXIT.permissions} ("WAITING"): tell me again where to tick, then rerun \`${brain} setup\` (same timeout). ` +
    `Code ${EXIT.download}: network or address, rerun the same command. ` +
    `Any other code (${EXIT.noScreenpipe}: connected without Screenpipe): run \`${brain} doctor --json\` and the fixes marked "safe" (same timeout), then tell me in one sentence what is left to do. ` +
    `On Windows, the client is \`${BRAIN_CLI_WINDOWS}\`. ` +
    `A "TO DO" line in the output: repeat it to me as is.`
  )
}

/** Where install.sh and the client keep a self-hosted brain's certificate. */
export const CA_FILE = "~/.company-brain/ca.crt"

const CA_NOTE = "   (self-hosted brain over local HTTPS: the command fetches its certificate and checks its fingerprint before using it; code 9 = different fingerprint, stop and tell me. On Windows, a dialog asks to confirm adding the certificate: accept.)\n"

/** "Fournil's", "Atelier Lumens'": the English possessive of a company name. */
export function possessive(name: string): string {
  const n = name.trim()
  return /s$/i.test(n) ? `${n}'` : `${n}'s`
}

/** Beyond this, the company description is cut at the last whole word: the prompt stays short. */
export const ABOUT_ORG_MAX = 300

/**
 * "The company, in a nutshell: "…".", from its description (/create, onboarding), on one line and in quotes (data,
 * not an instruction). Without a description, nothing: the prompt already names the company.
 */
export function aboutOrg(description?: string): string {
  let d = description?.replace(/\s+/g, " ").trim().replace(/\.$/, "")
  if (!d) return ""
  if (d.length > ABOUT_ORG_MAX) {
    const space = d.lastIndexOf(" ", ABOUT_ORG_MAX)
    d = `${d.slice(0, space > 0 ? space : ABOUT_ORG_MAX).replace(/[\s,;:.]+$/, "")}…`
  }
  return ` The company, in a nutshell: "${d}".`
}

export function buildInstallPrompt(opts: { baseUrl: string; token: string; name: string; orgName: string; orgDescription?: string; zones: string[]; caFingerprint?: string }): string {
  const { baseUrl, token, name, orgName, orgDescription, caFingerprint } = opts
  // The core is everyone's: the person's zones are the others.
  const zones = opts.zones.filter((z) => !isCoreZone(z))
  const brain = BRAIN_CLI
  const cmd = installCommands(baseUrl, `--token ${token}`, caFingerprint)
  return `You are going to connect this computer to NOS Brainer, ${possessive(orgName)} company brain.${aboutOrg(orgDescription)} I am ${name}, zones: ${zones.join(", ") || "none yet"}.
This message contains my personal token: never display it in full (brain-sync recognizes this conversation and never sends it to the brain). Be brief. ${LOCAL_ONLY} ${IF_BLOCKED}

1. Warn me in one sentence: on a Mac, System Settings will open and I will need to turn on "screenpipe" in "Screen Recording" then in "Accessibility"; the command waits and resumes on its own.
2. Run the command for my system as is, in a single call, with a 10-minute timeout (outside the sandbox if it is blocked there):
${commandLines(cmd)}
${caFingerprint ? CA_NOTE : ""}3. Code 0: it's done, the brain has opened in my browser. ${commonCodes(brain)}
4. Finish in three lines: what is running, what gets sent (distilled knowledge, never the raw screen; no history is sent) and how to remove everything (\`${brain} uninstall\`). Finally, offer to have the brain learn my last 24 h: first show me \`${brain} sync --dry-run --full --since 24h\` in full; nothing is sent before my explicit approval, then \`${brain} sync --confirm\` sends exactly what I reviewed.`
}

// The team message: the same for the whole company, to send to colleagues (never publicly). It grants access to
// nothing: the command creates a request, pre-filled by the requester's Claude, that an admin accepts or declines.
// The token is generated on the workstation and only its fingerprint goes with the request; once accepted, `brain join`
// moves on to `setup`. First sentence recognized by brain-sync (INSTALL_PROMPT_RE): do not rephrase it on its own.

/** Exit codes specific to `brain join` (apps/client/src/join.ts). */
export const JOIN_EXIT = { pending: EXIT.joinPending, rejected: EXIT.joinRejected } as const

export function buildJoinPrompt(opts: { baseUrl: string; code: string; orgName: string; orgDescription?: string; caFingerprint?: string }): string {
  const { baseUrl, code, orgName, orgDescription, caFingerprint } = opts
  const org = orgName.trim()
  const brain = BRAIN_CLI
  const cmd = installCommands(baseUrl, `--join ${code} --name "<first last>" --title "<role>" --email "<email>"`, caFingerprint)
  return `You are going to ask to join NOS Brainer, ${possessive(org)} company brain.${aboutOrg(orgDescription)} This team message contains ${possessive(org)} access code: never display it in full and never pass it on outside the company (brain-sync recognizes this conversation and never sends it to the brain). Be brief. ${LOCAL_ONLY} ${IF_BLOCKED}

1. Without asking me anything or running commands to look things up, prepare my request with what you already know about me (my account, your memory, our conversations): first and last name, role or job, work email. Make nothing up: for information you don't have, remove it from the command, an admin will fill it in.
2. Warn me in one sentence: an admin at ${org} must accept my request; the command waits for it, then installs everything (on a Mac, I will need to turn on "screenpipe" in "Screen Recording" then in "Accessibility").
3. Run the command for my system in a single call, with a 10-minute timeout (outside the sandbox if it is blocked there), replacing the values in angle brackets:
${commandLines(cmd)}
${caFingerprint ? CA_NOTE : ""}4. Code 0: request accepted and computer connected, the brain has opened in my browser. Code ${JOIN_EXIT.pending} ("WAITING FOR APPROVAL"): tell me my request is waiting for an admin and offer to rerun \`${brain} join\`, which resumes the same request. Code ${JOIN_EXIT.rejected}: the request was declined, nothing is installed. ${commonCodes(brain)}
5. Finish in three lines: what is running, what gets sent (distilled knowledge, never the raw screen; no history is sent) and how to remove everything (\`${brain} uninstall\`).`
}
