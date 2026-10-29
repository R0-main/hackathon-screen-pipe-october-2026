# Installing a computer: our CLI rather than instructions to Claude

> Decision made on 17/10/2026. The install prompt runs **our** CLI; it does not describe to Claude how to install
> everything. Details of the prompt: [install/PROMPT.md](../install/PROMPT.md).

## The problem

To connect a computer to the brain, you need Node.js, Screenpipe (installed, started, with the macOS permissions), our
client, the `company-brain` MCP, the Claude Code hooks and a scheduled sync. The employee pastes a prompt into Claude
Code; what is left is choosing who does the work.

## The two options

**A. Give Claude the links and let it figure things out.** The prompt lists Screenpipe, Node, the MCP docs, the hooks
to write; Claude Code installs its own way.

**B. Our own CLI.** The prompt downloads a script with `curl` and runs a command; the CLI does everything and returns an
exit code. Claude only runs it, reads the result and explains an error.

## The choice: B

| | A. Claude improvises | B. Our CLI |
|---|---|---|
| Result | Varies from one computer to the next: Screenpipe app or CLI, version, path, options | The same everywhere: pinned versions, fixed paths |
| Permissions in Claude Code | One per command (`brew`, `npm`, editing `~/.claude/settings.json`…) | **A single one** |
| Time and cost | Long, many tokens, depends on the model | A few minutes, almost nothing to reason about |
| On a failure | To redo by hand, nobody knows where it stopped | `brain setup` resumes where it stopped |
| Tests | Impossible | In CI (`apps/client/test`) |
| Security | The token goes through several commands; what gets installed is not under control | The token appears only once; we choose exactly what to install and from where |
| Prompt | Long, to maintain at every tool change | Short (~2,400 characters), stable |

For a demo in front of a jury as for a real fleet, the install must work **the same way every time**. Claude stays
useful where it is good: warning about permissions, reading an exit code, explaining an error and running again.

## How it is done

```
prompt  →  macOS, Linux, Git Bash: curl …/install.sh  →  sh install.sh --url … --token …
           Windows (PowerShell)  : Invoke-WebRequest …/install.ps1  →  powershell -File install.ps1 --url … --token …
                                    ├─ Node.js ≥ 20 found (outside a version manager), otherwise a pinned private copy
                                    │  in ~/.company-brain/node (without admin rights, official SHA-256 fingerprint checked)
                                    ├─ downloads …/brain.mjs, checks that it really is the client (not an error page),
                                    │  writes the ~/.company-brain/brain shortcut (Windows: brain.cmd)
                                    └─ brain setup --url … --token …
                                         ├─ config (~/.company-brain/config.json, mode 600)
                                         ├─ Screenpipe installed and started as a service, microphone off
                                         │  (--skip-screenpipe: none of it, remembered; `brain screenpipe on` later)
                                         ├─ macOS permissions: right pane opened, automatic resume
                                         ├─ company-brain MCP + Claude Code hooks + company skills (~/.claude/skills)
                                         ├─ sync every 15 min (upcoming activity only)
                                         └─ neon, then the brain opens in the browser, already signed in
```

Team message (join on request): `--join <code>` instead of `--token`; the script then runs `brain join`, which sends the
request, waits for an admin to accept it, then moves on to `setup` with the token created on the computer.

| File | Role |
|---|---|
| `apps/web/public/install.sh` | POSIX bootstrap (macOS, Linux; under Git Bash, hands over to `install.ps1`), served on `/install.sh`. |
| `apps/web/public/install.ps1` | Windows bootstrap (PowerShell 5.1 and 7), served on `/install.ps1`. |
| `apps/client/src/cli.ts`, `setup.ts` | The CLI, bundled into a single file `brain.mjs` (served on `/brain.mjs`, fingerprint on `/brain.mjs.sha256`). |
| `apps/client/src/doctor.ts` | `brain doctor`: read-only diagnosis, with the command that repairs each KO item (`--json` for Claude). |
| `apps/web/lib/install-prompt.ts` | The short prompt, generated with each employee's token. |
| `apps/web/lib/ca.ts`, `app/ca.crt/route.ts` | Self-hosted brain: certificate of the private authority served on `/ca.crt`, fingerprint pinned in the prompt (`--ca` on the `install.sh`, `install.ps1` and client side; on Windows, the certificate is added to the user's store). |
| `apps/client/test/install-prompt.test.ts` | The prompt only quotes commands and codes that exist; with a private certificate, `install.sh --ca` downloads through it and passes it to `setup`. |
| `apps/client/test/install-script.test.ts` | `install.sh` / `install.ps1`: downloads, error page refused, shortcuts, codes; in CI on Linux and Windows. |

Exit codes (scripts and `setup`):

| Code | Meaning | Next |
|---|---|---|
| 0 | Everything is connected | — |
| 1 | `setup` failed | `brain doctor` says what, with the command that repairs |
| 2 | Bad call (`--url` missing or invalid, run with `sudo`) | Run the prompt's command again as is |
| 3 | macOS "Screen Recording" permission pending | Tick it, then `~/.company-brain/brain setup` |
| 4 | Unsupported system, or Node.js cannot be installed here | The message says what to install |
| 5 | Download impossible (network, proxy, address, error page) | Run the same command again; the old client stays intact |
| 6 | Everything is connected except Screenpipe (no build for this computer, or it does not start) | `brain doctor` says why |
| 7 | Team message (`--join`): the request is still waiting for an admin to accept it | `~/.company-brain/brain join` resumes the same request |
| 8 | Team message: request declined, nothing is installed | — |

A code has the same meaning whatever the command that returns it (`install.sh`, `install.ps1`, `setup`, `join`): a test
checks it (`apps/client/test/install-prompt.test.ts`).

## `brain doctor`

When something gets stuck, Claude does not have to guess: `brain doctor --json` reviews the computer (Node.js and
shortcut, connection to the brain and client version, Screenpipe and its permissions, Claude Code's MCP and hooks,
scheduled sync and its log, distillation) **without changing anything**, and gives for each KO item the command that
repairs it. It really runs what the shortcut, the hooks, the MCP and the scheduled sync run (`_probe`): a path left on
an old Node.js or an old client shows up right away. The commands marked `safe` only reconnect the computer; Claude
runs them without asking again. Details: [install/PROMPT.md](../install/PROMPT.md#brain-doctor-the-diagnosis).

No command to query the brain from the terminal: that is the role of the `company-brain` MCP, in Claude Code.

Why `sh ~/.company-brain/install.sh` rather than `curl … | sh`: the script stays on disk, Claude or the employee can
read it again, and a cut download never runs halfway.

## Limits and next steps

- **Windows**: install, shortcuts, MCP, hooks (run without a shell, so also without Git Bash) and scheduled sync are
  handled, but not tried on a real computer yet (only in CI on `windows-latest`). Screenpipe runs there in the
  background, without a service: after a reboot, `brain doctor` flags it and `brain setup` starts it again. The
  scheduled task opens a console every 15 min and does not run on battery (default `schtasks` settings): to turn into a
  hidden XML task.
- **Linux**: Screenpipe 0.4.52 needs glibc ≥ 2.39 (Ubuntu 24.04 and later) and pipewire / pulseaudio; without them,
  `setup` connects the rest and exits with 6. Nothing for linux-arm64 or Windows on ARM without x64 emulation.
- **Remove Node**: compile the client into a standalone binary per platform (Node SEA or `bun build --compile`) and
  publish it. `install.sh` would then download that binary instead of Node + `brain.mjs`.
- **Sign `install.sh` and `brain.mjs`** or publish their fingerprints, so that a computer can check what it runs even if
  the brain's server were compromised.
