# Host the brain on a company machine

> The brain runs at your place, on a company computer that is always on, and the computers reach it on the local
> network over HTTPS. Nothing leaves the company: neither the captures (which stay on each computer) nor the distilled
> knowledge (which stays on this machine). The cloud ([README](../README.md#deploy-the-shared-brain-vercel--neon-free-tiers))
> becomes an option, not a prerequisite.

## In three commands

```bash
git clone <this repo> && cd hackathon-screen-pipe-october-2026
sh deploy/local/brain-local.sh up      # writes .env, builds the image, starts Postgres + brain + Caddy, shows the address
sh deploy/local/brain-local.sh status  # later: state and addresses
```

Prerequisites: [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS, Windows) or Docker Engine with
Compose v2 (Linux), ports 80 and 443 free on the machine, and `openssl` (present on macOS and Linux). The first build
takes a few minutes (it downloads the dependencies and the fonts); the following ones are quick.

At the end, the script shows:

- the brain's address (`https://192.168.1.20` for example, and the certificate's other names);
- the first thing to do: `https://<address>/create` creates the company and its first admin account;
- the root certificate exported to `deploy/local/ca.crt`, its SHA-256 fingerprint, and the command that installs it for
  this machine's browser (the employees' computers have nothing to do: see below).

## What runs

| Container | Role |
|---|---|
| `postgres` | Postgres 16, data in the `brain-postgres` Docker volume. The schema is applied when the brain starts (`npm run db:migrate`, each migration only once). |
| `brain` | The Next.js dashboard, its API and the `brain.mjs` client served on `/brain.mjs`, built from this repo (`Dockerfile`). |
| `caddy` | HTTPS in front of the brain. By default, a private authority created by Caddy signs a certificate for every address of `BRAIN_HOSTS`; the root certificate is served on `/ca.crt`. |

Files: `compose.yaml` (the three services), `Dockerfile`, `deploy/local/Caddyfile`, `deploy/local/entrypoint.sh`
(migrations then start), `deploy/local/brain-local.sh` (the control script), `.env` at the root (written by `up`,
template in `deploy/local/env.example`).

## Connect the computers

The path is the same as in the cloud: `/admin` → "Invite someone" → an install prompt the employee pastes into Claude
Code. A single thing changes, because the brain is signed by an authority the computers do not know yet: the prompt's
single command starts by fetching the certificate (`/ca.crt`) and **checks its SHA-256 fingerprint, pinned in the
prompt** (the server computes it from `BRAIN_CA_FILE`). It only carries on if the fingerprint matches; `install.sh` then
downloads `brain.mjs` with this certificate, and `brain setup --ca`:

- saves it in `~/.company-brain/config.json`: the sync, the MCP and the hooks trust it, on top of the public
  certificates (nothing else is changed on the computer);
- installs it for the computer's browsers (login keychain on macOS, user store on Windows, NSS database for Chrome on
  Linux), once per certificate; Firefox has its own store (Settings → Certificates → Import).

On Windows, the prompt's command (PowerShell) does the same: certificate fetched, fingerprint checked (code 9 if it
differs), added to the user's store (Windows asks for a confirmation), then `install.ps1 --ca`.

The team message ("join on request") does the same. Full example of the prompt: [install/PROMPT.md](../install/PROMPT.md#self-hosted-brain-https-on-the-local-network).

The day the authority changes (machine reinstalled, switch to your own certificates), each computer runs
`~/.company-brain/brain setup --ca <new certificate>` again, or reinstalls with a new prompt.

## HTTPS: the possible choices

| Option | When | How |
|---|---|---|
| **Caddy's private authority** (default, `BRAIN_TLS=internal`) | Local network, no domain name | Nothing to do. The certificate covers `BRAIN_HOSTS`: `localhost`, the machine's IP addresses and `<machine-name>.local` (mDNS, recognized by macOS, Windows 10+ and Linux with Avahi). The computers fetch and check the certificate through the prompt. |
| **Your certificates** (`BRAIN_TLS="/certs/cert.pem /certs/key.pem"`) | Your IT already has an internal authority, or a domain name with a real certificate | Put `cert.pem` and `key.pem` in `deploy/local/certs/` (ignored by git), put the name in `BRAIN_HOSTS`, then `up`. If the authority is already trusted by the computers, the prompts pin nothing. |
| Remote employees | Outside the local network | A company VPN, or an overlay network like Tailscale (which also provides a valid name and certificate): the brain stays at your place. |

A name rather than an IP address: add it to `BRAIN_HOSTS` (and `BRAIN_HOST`) in `.env`, then `up`. Caddy issues the
certificate again; the computers already connected keep the same root certificate, nothing to redo.

## Claude

Two modes, which can be combined:

- **On each computer** (already the case in the cloud): `brain-sync` distills with `claude -p`, so the employee's Claude
  Code subscription; no key on the server.
- **On the brain's machine**: `ANTHROPIC_API_KEY` in `.env` serves the server's features ("Where does the company
  stand", onboarding). The calls go from this machine to the Anthropic API; without a key, the server keeps its heuristics.

## Operations

| Need | Command |
|---|---|
| State, addresses | `sh deploy/local/brain-local.sh status` |
| Logs | `sh deploy/local/brain-local.sh logs` |
| Backup | `sh deploy/local/brain-local.sh backup` → `deploy/local/backups/brain-<date>.sql.gz` (to copy elsewhere) |
| Restore | `gunzip -c <file> \| docker compose exec -T postgres psql -U brain brain` |
| Update | `sh deploy/local/brain-local.sh update` (git pull, rebuild, restart; the data stays) |
| Root certificate | `sh deploy/local/brain-local.sh ca` (exports `deploy/local/ca.crt` again, shows the fingerprint) |
| Stop | `sh deploy/local/brain-local.sh down` (the volumes stay; `docker compose down -v` deletes everything) |
| Demo | `BRAIN_DEMO=1` in `.env` then `up`: the fictitious company Encore loads the first time `/login` is opened |

The containers restart with Docker (`restart: unless-stopped`): if the machine reboots, the brain comes back on its own.

## Troubleshooting

- **Port 80 or 443 already taken**: another web server is running (`lsof -i :443`). Stop it, or change the ports in
  `compose.yaml` and set `BRAIN_HOST=<address>:<port>`.
- **The prompt stops at the fingerprint check**: the computer did not get the expected certificate. Either the address
  is wrong (another service answers), or the authority changed since the prompt was generated (`ca` shows the current
  fingerprint; generate the prompt again from `/admin`). Never work around this check.
- **"Caddy has not created its authority yet"**: the first start takes a few seconds; run `ca` again.
- **Security warning in your browser** on the brain's machine: install the root certificate with the command shown by
  `ca` (or accept the exception, the time to create the company).
- **Postgres refuses the connection on start**: `logs`; the brain waits for Postgres to be ready (`healthcheck`), a
  password changed in `.env` after the first creation does not apply to the existing volume (`docker compose down -v`
  to start from scratch, losing the data).

## What changes compared to the cloud

| | Cloud (Vercel + Neon) | Company machine |
|---|---|---|
| Where the distilled data is | At the host (Neon, Frankfurt) | In a Docker volume on your machine |
| Address | `https://brain.example.com` | `https://<ip or name>.local`, local network (or VPN) |
| Certificate | Public, automatic | Caddy's private authority, pinned in the prompts; or yours |
| Availability | Always online | As long as the machine is on; the computers' sync retries every 15 min |
| Update | git deployment | `brain-local.sh update` |
| Backup | At the host | `brain-local.sh backup` |
| Cost | Free tiers | A computer that is on |

The code is the same: two storages behind a single interface (`apps/web/lib/store`), a single API, a single client.
