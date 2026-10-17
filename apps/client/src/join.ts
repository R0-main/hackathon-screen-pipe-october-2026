// `brain.mjs join`: join a company with the team message (one code per company, no personal token).
// The computer's token is generated here and only its fingerprint goes with the request; the computer waits for an admin
// to accept it (POST /api/join/status), then moves on to `setup` with this token (and returns its code). Without an answer
// in time: code 7, and `join` without parameters resumes the same request (state in ~/.company-brain/join.json, mode 600).

import { createHash, randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { brainHome, ensureHome, readJson, UserError, writeJson } from "./config"
import { applyCa, readCaFile } from "./ca"

type Log = (s: string) => void

// After those of the install scripts and of setup (5: download failed, 6: connected without Screenpipe): one code,
// one meaning, whatever the command that returned it.
export const EXIT_JOIN_PENDING = 7
export const EXIT_JOIN_REJECTED = 8
export const DEFAULT_ACCEPT_WAIT_S = 480

type JoinState = { url: string; id: string; token: string; org: string; name?: string }

export const joinStatePath = () => join(brainHome(), "join.json")

export type JoinDeps = {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  /** What comes next once the request is accepted (by default: `setup --url --token`). */
  setup?: (flags: Record<string, string | boolean>, log: Log) => Promise<number>
}

/** `join` options that are none of `setup`'s business (the rest, --audio, --wait, --no-open…, is passed on to it). */
const JOIN_ONLY = ["join", "code", "name", "title", "email", "wait-accept", "url", "token"]

async function post<T>(f: typeof fetch, url: string, path: string, body: unknown): Promise<{ status: number; data: T & { error?: string } }> {
  let res: Response
  try {
    res = await f(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new UserError(`Cannot reach the brain (${url}): ${(err as Error).message}`)
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  return { status: res.status, data }
}

export async function cmdJoin(flags: Record<string, string | boolean>, log: Log = console.log, deps: JoinDeps = {}): Promise<number> {
  const f = deps.fetch ?? fetch
  // Self-hosted brain: the request goes over HTTPS to its certificate before any config.
  if (typeof flags.ca === "string" && flags.ca.trim()) applyCa(readCaFile(flags.ca.trim()).certs)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string).trim() : undefined)
  const waitS = str("wait-accept") !== undefined ? Number.parseInt(str("wait-accept")!, 10) : DEFAULT_ACCEPT_WAIT_S
  if (!(waitS >= 0)) throw new UserError("--wait-accept: a number of seconds.")

  const code = str("join") ?? str("code")
  const url = str("url")?.replace(/\/+$/, "")
  let state = readJson<JoinState>(joinStatePath())

  if (code) {
    if (!url) throw new UserError("Usage: join --url <brain address> --join <team code> [--name …] [--title …] [--email …]")
    // Same brain, request already made: we resume it rather than create a second one.
    if (!state || state.url !== url) {
      const token = `cb_${randomBytes(24).toString("base64url")}`
      const token_hash = createHash("sha256").update(token).digest("hex")
      const fields = { name: str("name"), title: str("title"), email: str("email"), hostname: hostname().replace(/\.local$/, "") }
      const r = await post<{ id: string; org: string }>(f, url, "/api/join", { code, token_hash, ...fields })
      if (r.status !== 201) throw new UserError(`Request refused by the brain (${r.status}): ${r.data.error ?? "unexpected answer"}`)
      state = { url, id: r.data.id, token, org: r.data.org, name: fields.name }
      ensureHome()
      writeJson(joinStatePath(), state, 0o600)
      log(`Request sent to ${state.org}${fields.name ? ` in the name of ${fields.name}` : ""}: an admin must accept it (Team and access).`)
    } else log(`Request already sent to ${state.org}: still waiting for an admin to accept it.`)
  } else if (!state) {
    throw new UserError("No request in progress: run the team message (join --url <address> --join <code>).")
  } else log(`Resuming the request sent to ${state.org}.`)

  const deadline = Date.now() + waitS * 1000
  let lastNote = Date.now()
  for (;;) {
    const r = await post<{ status: string; org: string }>(f, state.url, "/api/join/status", { id: state.id, token: state.token })
    if (r.status === 404) {
      rmSync(joinStatePath(), { force: true })
      throw new UserError("The brain no longer knows this request: run the team message again.")
    }
    if (r.status !== 200) throw new UserError(`The brain answered ${r.status}${r.data.error ? `: ${r.data.error}` : ""}.`)
    if (r.data.status === "accepted") {
      log(`Request accepted by ${state.org}. Setting up the computer.`)
      const rest = Object.fromEntries(Object.entries(flags).filter(([k]) => !JOIN_ONLY.includes(k)))
      const setup = deps.setup ?? (async (fl, lg) => (await import("./setup")).cmdSetup(fl, lg))
      const out = await setup({ ...rest, url: state.url, token: state.token }, log)
      // The token is now in config.json (cmdInit): the request state is no longer needed.
      rmSync(joinStatePath(), { force: true })
      return out
    }
    if (r.data.status === "rejected") {
      rmSync(joinStatePath(), { force: true })
      log(`REJECTED: ${state.org} did not accept the request. Nothing was installed.`)
      return EXIT_JOIN_REJECTED
    }
    if (Date.now() >= deadline) {
      log(`WAITING FOR ACCEPTANCE: an admin of ${state.org} must accept the request (Team and access, then Requests). Then run \`join\` again: it resumes the same request.`)
      return EXIT_JOIN_PENDING
    }
    if (Date.now() - lastNote >= 60_000) {
      lastNote = Date.now()
      log(`Still waiting for an admin (${Math.round((deadline - Date.now()) / 1000)} s left).`)
    }
    await sleep(deps.pollMs ?? 3000)
  }
}
