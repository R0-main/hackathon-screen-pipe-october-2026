# The NOS Brainer install prompt

The dashboard generates it for each employee (`/admin` → "Invite someone" or "New prompt"), with their personal token
(shown only once) and the brain's URL. Source: [apps/web/lib/install-prompt.ts](../apps/web/lib/install-prompt.ts).

The employee pastes it into Claude Code. Claude warns about the permissions to come, runs **a single command** (the one
for their system: the prompt gives one for macOS / Linux / Git Bash and one for Windows PowerShell), reads its exit code
and, on an error, relies on `brain doctor --json`. The prompt stays short because the work is in our CLI (why:
[docs/CLI.md](../docs/CLI.md)):

- `install.sh` (served at `/install.sh`, source `apps/web/public/install.sh`, macOS and Linux) finds Node.js ≥ 20 or
  installs a private copy in `~/.company-brain/node` (without admin rights, SHA-256 fingerprint checked, Apple Silicon
  even under Rosetta, Alpine included), checks that `brain.mjs` really is the client before replacing the old one, writes
  the `~/.company-brain/brain` shortcut, then runs `brain setup` with the same options and returns its exit code. Run
  from Git Bash on Windows, it hands over to `install.ps1`;
- `install.ps1` (served at `/install.ps1`, Windows PowerShell 5.1 or 7) does the same on Windows: private copy of
  Node.js x64 (also on ARM64, which Windows emulates: Screenpipe only exists for x64), `brain.cmd` (PowerShell, cmd) and
  `brain` (Git Bash) shortcuts;
- `brain setup` (`apps/client/src/setup.ts`) does the rest:

1. **Brain**: saves the URL and the token (`~/.company-brain/config.json`, mode 600) and tests the connection.
2. **Screenpipe**: if it is already running (app or CLI), we keep it. Otherwise the app if it is installed, otherwise the
   official CLI (npm package `screenpipe`, version pinned in `SCREENPIPE_VERSION`) installed in `~/.company-brain/screenpipe`
   and run as a service (`screenpipe service install`: launchd on macOS, systemd on Linux; in the background otherwise).
   Recording options: microphone off, "memory" app context (the `parsed` data brain-sync reads), videos and screenshots
   deleted after 14 days (the text stays). The local API token is read and saved on its own.
3. **Permissions** (macOS): opens the right Settings pane, then watches `GET /health` and carries on as soon as capture
   starts. Nobody has to come back to the terminal to say "done".
4. **Claude Code and Codex**: the company's MCP server, `nos-brainer-<company>`, plugged straight into the brain
   (`<brain>/api/mcp/<company id>/<token>`, HTTP): `claude mcp add --transport http` (user scope) and
   `~/.codex/config.toml` if Codex is there. It shows as "Connected" in `/mcp` and `claude mcp list`, and in
   `codex mcp list`. A second company installed on the computer gets its own next to it. Brain with a private
   certificate: the computer's MCP server (`company-brain`, stdio) instead. Then the `SessionStart` /
   `UserPromptSubmit` / `Stop` hooks.
5. **Sync** every 15 minutes, starting now: only the activity to come is sent, never the history.
6. **Neon and browser**: `hello` lights up the person's zones, then the brain opens **already signed in** thanks to a
   sign-in link valid for 2 minutes (`POST /api/session/link`, without the token in the URL), with a welcome banner.
   They see the brain light up on every Claude Code session, and the knowledge arrive as the syncs go by.

`setup` is idempotent: without parameters, it resumes where it stopped, and points the MCP, the hooks and the scheduled
sync back to the current client if they pointed to an old path (reinstall, Node.js updated), without skipping what is
waiting to be sent. Screenpipe is installed by npm **without** its post-install script (which would download ffmpeg
from a third-party site, run `sudo apt-get` and send telemetry): Screenpipe installs ffmpeg itself on its first run.

| Code | Meaning | What Claude does |
|---|---|---|
| 0 | Everything is connected, the brain has opened | Sums up |
| 3 | WAITING: "Screen Recording" permission not granted yet (macOS) | Says again where to tick, reruns `brain setup` |
| 5 | Download impossible (network, proxy, wrong address, error page instead of the client) | Reruns the same command |
| 6 | Everything is connected **except Screenpipe** (no build for this computer, or it does not start) | `brain doctor --json`, explains |
| 7 | Team message: request not accepted by an admin yet | Offers to rerun `brain join` (same request) |
| 8 | Team message: request declined, nothing is installed | Says so |
| 1, 2, 4 | Setup failure, bad call, unsupported system | `brain doctor --json`, explains, runs the "safe" fixes |

## Without an agent: the same command in a terminal

The agent stays the main way. Under its buttons (home page, `/create`), a line in small offers the prompt's command
for macOS / Linux or for Windows, to paste yourself into a terminal: the same install, Node.js included when it is
missing (link to nodejs.org for those who would rather install it themselves). Only the agent's extras are left
out, the review of the last 24 h included: the brain learns from the install onward. The command comes from the
prompt (`terminalCommands` in [apps/web/lib/install-prompt.ts](../apps/web/lib/install-prompt.ts)); in PowerShell, its
`exit`s, which would close the window before the output can be read, become a warning that stops the line. Stuck:
`~/.company-brain/brain doctor` (Windows: `~/.company-brain/brain.cmd doctor`).

## `brain doctor`: the diagnosis

`~/.company-brain/brain doctor` (Windows: `~/.company-brain/brain.cmd doctor`) checks the whole computer **without
changing anything** and gives, for each KO item, the command that repairs it:

| Group | What is checked |
|---|---|
| Computer | Node.js (version, version manager that will break the paths, Rosetta), shortcut (it starts and runs this client), private folder |
| Brain | Config, connection and token (revoked?), client up to date with the one the brain serves (`/brain.mjs.sha256`) |
| Screenpipe | Answers, captures the screen (permission refused, capture stalled, power saving), Accessibility, local API token, "parsed" data |
| Claude Code | `claude` CLI, each company's MCP server (registered at the right address and it answers; otherwise `company-brain`, registered and it starts), hooks (all three, without duplicates, on the current client, startable without Git Bash on Windows), recent hook errors |
| Codex | Each company's MCP server declared in `~/.codex/config.toml` (if Codex is installed) |
| Sync | Schedule (and what it really runs), last sync, last error of the log, orphaned lock, pending conversations, unconfirmed dry run |
| Distillation | Claude Code or API key, `claude` found by the scheduled sync, Claude sign-in lost (expired token) |

`--json` gives the same report to Claude Code: `checks[]` (`id`, `status` ok / warn / fail / skip / info, `detail`, `fix`,
`command`, `safe`), `next` (the first item to fix) and `exit_code` (1 if a KO is left). `safe: true` marks the commands
that only reconnect the computer (`setup`, `install-hooks`, reinstall); never `sync --confirm` or `init --claude-token`,
which need the employee. No token is ever shown in full, no data from the log is copied without being redacted.

## Permissions: what we avoid, what we cannot avoid

| Where | Before | Now |
|---|---|---|
| Claude Code | one permission per step (about ten commands) | **a single one**: the single command. Zero when pasting it straight into a terminal. |
| macOS, Microphone | asked | **removed**: microphone off by default (`setup --audio yes` to transcribe meetings) |
| macOS, Screen Recording | to find in Settings | **one click**: pane opened, binary path copied if "screenpipe" is not listed, automatic resume |
| macOS, Accessibility | to find in Settings | **one click, optional**: improves reading terminal text; without it, capture still works |
| Linux, Windows | nothing | nothing (on Wayland, accept screen sharing if offered) |
| Windows, Claude Code | one permission per command (winget, Node, settings) | **a single one**: the PowerShell line (or the Git Bash one) |

What cannot be skipped: macOS requires the employee to grant Screen Recording themselves, even on a managed fleet. In a
company, an MDM profile (PPPC) can pre-grant Accessibility to the `screenpipe` binary (signed with Developer ID, team
`URFF7QHPUR`) and allow a standard user to tick Screen Recording without an admin password.

## Example (fake token)

When the company has a description (entered in `/create` or during onboarding), the first line repeats it after the
company name (`The company, in a nutshell: "…".`), on one line and cut at 300 characters. The team message does the
same. Without a description, the line stays as in the example.

```text
You are going to connect this computer to NOS Brainer, Encore's company brain. I am Jean-Marc Dubois, zones: finance.
This message contains my personal token: never display it in full (brain-sync recognizes this conversation and never sends it to the brain). Be brief. If you are not running on my computer (cloud session, remote container), stop and tell me in one sentence to paste this message again into Claude Code or Codex locally (the `claude` or `codex` terminal). Action blocked or refused: work around nothing, tell me in one sentence what to do, with no list or explanation, then wait.

1. Warn me in one sentence: on a Mac, System Settings will open and I will need to turn on "screenpipe" in "Screen Recording" then in "Accessibility"; the command waits and resumes on its own.
2. Run the command for my system as is, in a single call, with a 10-minute timeout (outside the sandbox if it is blocked there):
   macOS, Linux, Git Bash: (curl -fsSL --create-dirs https://brain.example.com/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url https://brain.example.com --token cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   Windows, PowerShell: New-Item -ItemType Directory -Force "$env:USERPROFILE\.company-brain" | Out-Null; try { Invoke-WebRequest -UseBasicParsing https://brain.example.com/install.ps1 -OutFile "$env:USERPROFILE\.company-brain\install.ps1" -ErrorAction Stop } catch { exit 5 }; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.company-brain\install.ps1" --url https://brain.example.com --token cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX; exit $LASTEXITCODE
3. Code 0: it's done, the brain has opened in my browser. Code 3 ("WAITING"): tell me again where to tick, then rerun `~/.company-brain/brain setup` (same timeout). Code 5: network or address, rerun the same command. Any other code (6: connected without Screenpipe): run `~/.company-brain/brain doctor --json` and the fixes marked "safe" (same timeout), then tell me in one sentence what is left to do. On Windows, the client is `~/.company-brain/brain.cmd`. A "TO DO" line in the output: repeat it to me as is.
4. Finish in three lines: what is running, what gets sent (distilled knowledge, never the raw screen; no history is sent) and how to remove everything (`~/.company-brain/brain uninstall`). Finally, offer to have the brain learn my last 24 h: first show me `~/.company-brain/brain sync --dry-run --full --since 24h` in full; nothing is sent before my explicit approval, then `~/.company-brain/brain sync --confirm` sends exactly what I reviewed.
```

## `setup` options

| Option | Effect |
|---|---|
| `--url <url> --token <token>` | First install (not needed afterwards). |
| `--audio yes\|no` | Microphone and meeting transcription (no by default; macOS then also asks for the Microphone). |
| `--wait <seconds>` | Wait for the macOS permissions (300 by default). |
| `--no-open` | Does not open the browser. |
| `--skip-screenpipe` | Without Screenpipe: brain-sync only reads the Claude Code and Codex sessions. |
| `--ca <pem>` | Self-hosted brain over local HTTPS: certificate of its private authority, which the client trusts (see below). |

Remove everything: `~/.company-brain/brain uninstall` (hooks, MCP, company skills, sync, Screenpipe service; `--purge`
also deletes `~/.company-brain`). Screenpipe's recordings stay in `~/.screenpipe`.

## Self-hosted brain (HTTPS on the local network)

When the brain runs on a company machine ([docs/LOCAL.md](../docs/LOCAL.md)), it is served over HTTPS by a private
authority the computers do not know yet. The prompt then changes by a single line: the command first fetches the
certificate (`/ca.crt`), checks its SHA-256 fingerprint (pinned in the prompt, computed by the server from
`BRAIN_CA_FILE`), and only carries on if it matches; `install.sh` then downloads `brain.mjs` with this certificate and
`setup --ca` saves it for the client (sync, MCP, hooks) and installs it for the computer's browsers.
With a public certificate (cloud), none of this appears.

```text
You are going to connect this computer to NOS Brainer, Encore's company brain. I am Jean-Marc Dubois, zones: finance.
This message contains my personal token: never display it in full (brain-sync recognizes this conversation and never sends it to the brain). Be brief. If you are not running on my computer (cloud session, remote container), stop and tell me in one sentence to paste this message again into Claude Code or Codex locally (the `claude` or `codex` terminal). Action blocked or refused: work around nothing, tell me in one sentence what to do, with no list or explanation, then wait.

1. Warn me in one sentence: on a Mac, System Settings will open and I will need to turn on "screenpipe" in "Screen Recording" then in "Accessibility"; the command waits and resumes on its own.
2. Run the command for my system as is, in a single call, with a 10-minute timeout (outside the sandbox if it is blocked there):
   macOS, Linux, Git Bash: mkdir -p ~/.company-brain && (curl -ksSL https://192.168.1.20/ca.crt -o ~/.company-brain/ca.crt || exit 5) && ([ "$(openssl x509 -in ~/.company-brain/ca.crt -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)" = "33483DC29874755818A10E941E52452421D5FF791FCF37578DB0E4EC570DF8F5" ] || exit 9) && (curl -fsSL --cacert ~/.company-brain/ca.crt https://192.168.1.20/install.sh -o ~/.company-brain/install.sh || exit 5) && sh ~/.company-brain/install.sh --url https://192.168.1.20 --token cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX --ca ~/.company-brain/ca.crt
   Windows, PowerShell: New-Item -ItemType Directory -Force "$env:USERPROFILE\.company-brain" | Out-Null; $ca = "$env:USERPROFILE\.company-brain\ca.crt"; $skip = @{}; if ($PSVersionTable.PSVersion.Major -ge 6) { $skip = @{ SkipCertificateCheck = $true } } else { [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } }; try { Invoke-WebRequest -UseBasicParsing https://192.168.1.20/ca.crt -OutFile $ca -ErrorAction Stop @skip } catch { exit 5 }; [Net.ServicePointManager]::ServerCertificateValidationCallback = $null; $c = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $ca; if (([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData)) -replace '-') -ne '33483DC29874755818A10E941E52452421D5FF791FCF37578DB0E4EC570DF8F5') { exit 9 }; if (-not (Get-ChildItem Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $c.Thumbprint)) { certutil -user -addstore Root $ca | Out-Null }; try { Invoke-WebRequest -UseBasicParsing https://192.168.1.20/install.ps1 -OutFile "$env:USERPROFILE\.company-brain\install.ps1" -ErrorAction Stop } catch { exit 5 }; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.company-brain\install.ps1" --url https://192.168.1.20 --token cb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX --ca $ca; exit $LASTEXITCODE
   (self-hosted brain over local HTTPS: the command fetches its certificate and checks its fingerprint before using it; code 9 = different fingerprint, stop and tell me. On Windows, a dialog asks to confirm adding the certificate: accept.)
3. Code 0: it's done, the brain has opened in my browser. Code 3 ("WAITING"): tell me again where to tick, then rerun `~/.company-brain/brain setup` (same timeout). Code 5: network or address, rerun the same command. Any other code (6: connected without Screenpipe): run `~/.company-brain/brain doctor --json` and the fixes marked "safe" (same timeout), then tell me in one sentence what is left to do. On Windows, the client is `~/.company-brain/brain.cmd`. A "TO DO" line in the output: repeat it to me as is.
4. Finish in three lines: what is running, what gets sent (distilled knowledge, never the raw screen; no history is sent) and how to remove everything (`~/.company-brain/brain uninstall`). Finally, offer to have the brain learn my last 24 h: first show me `~/.company-brain/brain sync --dry-run --full --since 24h` in full; nothing is sent before my explicit approval, then `~/.company-brain/brain sync --confirm` sends exactly what I reviewed.
```

## The team message (join on request)

Second way to add someone, next to the personal prompt: a single message per company (`/admin` → Requests, or the last
step of `/create`), source `buildJoinPrompt` in [apps/web/lib/install-prompt.ts](../apps/web/lib/install-prompt.ts).
It contains a team code (`cj_…`), no token: to send to colleagues only, it only allows asking.

1. The requester's Claude fills in `--name`, `--title`, `--email` with what it already knows about the person (their
   account, its memory, their conversations), without asking any question, running commands to look things up or
   making anything up: an unknown value is left out, the admin will fill it in.
2. The command for their system (`install.sh --join` on macOS / Linux / Git Bash, `install.ps1 --join` on Windows) runs
   `brain join` (`apps/client/src/join.ts`): the computer's token is created locally, the request goes with its
   fingerprint only, then the command waits for approval (8 min).
3. An admin completes and accepts the request: the account is created with this fingerprint, and `join` moves on to
   `setup` (same codes: 0, 3, 5, 6, or `doctor` on an error). Code 7: still waiting (`brain join` resumes the same
   request, state in `~/.company-brain/join.json`); 8: declined, nothing is installed.
