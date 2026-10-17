"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { slugify } from "@brain/core"
import type { ZoneView } from "@/lib/brain"
import { AgentLogos } from "./brand-logos"
import { AgentRun, AgentToasts, useAgentOnboarding, type AgentEvent, type RunState } from "./AgentProgress"
import { Brain3D, type BrainPerson } from "./Brain3D"
import type { ZoneActivity } from "./BrainViz"
import { PersonAvatar } from "./PersonDot"
import { PromptActions, copyText } from "./PromptActions"
import { TeamJoin } from "./TeamJoin"
import { api, errorMessage } from "./format"
import { CheckIcon, CloseIcon, Dot, ErrorText, LogoMark, PlusIcon, ZONE_PALETTE, ZoneTag, zoneColor } from "./ui"
import { deNom } from "@/lib/install-prompt"

type ZoneOption = { id: string; name: string; description: string; color: string; position: number }
type Step = "intro" | "company" | "about" | "you" | "context" | "zones" | "install" | "team"
/** Une personne ajoutée depuis cette page : invitée (son prompt personnel), ou acceptée via le message d'équipe (prompt vide). */
type Invite = { id: string; name: string; title?: string; zones: string[]; prompt: string }
/** `token` : le jeton de l'admin (déjà dans `prompt`), renvoyé à l'étape des zones pour refaire ce prompt. */
type Created = { orgName: string; meId: string; prompt: string; zones: ZoneOption[]; token?: string }
type TeamUser = { id: string; last_at: string | null }
/** Zone proposée par Claude Code ou Codex (étape « context »). */
type ProposedZone = { id: string; name: string; description: string; keywords: string[] }
/** Proposition de Claude Code ou Codex : zones, premières connaissances, description de l'entreprise. `received_at` : sa version. */
type Proposal = { zones: ProposedZone[]; items: unknown[]; description: string; received_at?: string }

type Saved = {
  step: Step
  company: string
  description: string
  name: string
  title: string
  picked: string[]
  custom: string[]
  created: Created | null
  invites: Invite[]
  proposal: Proposal | null
}

/** Étapes numérotées (barre de progression) : l'intro n'en fait pas partie. */
const STEPS: Step[] = ["company", "about", "you", "context", "zones", "install", "team"]
const DEFAULT_PICK = ["dev", "produit", "direction"]
/**
 * La progression survit à un rechargement, dans cet onglet seulement (sessionStorage, effacé à sa fermeture). Elle
 * contient les prompts, donc les jetons : c'est ce qui permet de les recopier après un rechargement.
 */
const STORAGE_KEY = "nos-brainer:creer"
/**
 * Posé dans l'adresse à l'ouverture du parcours (`/creer?brouillon=1`) : un rechargement ou un retour arrière reprend le
 * brouillon, alors qu'arriver par un lien (« Créer mon entreprise ») recommence de zéro, même après une entreprise créée.
 */
const DRAFT_PARAM = "brouillon"
const POLL_MS = 3000
/** Fond de la page (--color-bone) : le cerveau de l'aperçu s'y fond, comme sur la landing. */
const BONE = 0xf6f6f3

function load(): Partial<Saved> | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Partial<Saved>) : null
  } catch {
    return null
  }
}

/** Zones du brouillon avec leurs couleurs (proposées par Claude et gardées, cochées, ajoutées) : l'aperçu du petit cerveau. */
function draftZoneList(all: ZoneOption[], picked: string[], custom: string[], proposed: ProposedZone[] = []): ZoneOption[] {
  const fromClaude = proposed
    .filter((z) => picked.includes(z.id))
    .map((z, i) => ({ id: z.id, name: z.name, description: z.description, color: ZONE_PALETTE[i % ZONE_PALETTE.length], position: 0 }))
  const chosen = [...fromClaude, ...all.filter((z) => picked.includes(z.id) && !fromClaude.some((c) => c.id === z.id))]
  const free = ZONE_PALETTE.filter((c) => !chosen.some((z) => z.color === c))
  const extra = custom.map((name, i) => ({ id: `custom-${slugify(name)}`, name, description: "", color: free[i] ?? zoneColor(null, chosen.length + i), position: 0 }))
  return [...chosen, ...extra].map((z, position) => ({ ...z, position }))
}

function save(s: Saved) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {}
}

function clear() {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {}
}

/**
 * Créer son entreprise à partir de zéro, une question par écran : nom, activité, qui on est. Le cerveau est alors créé
 * (sans zone) ; Claude Code ou Codex peut proposer ses zones à partir des conversations du poste (étape passable), et
 * l'étape des zones part de sa proposition. Ensuite, le prompt à coller dans Claude Code ou Codex pour brancher son poste,
 * puis un prompt par collègue pour l'inviter.
 * Les postes branchés apparaissent en direct (lecture de /api/admin/team).
 */
export function CreateCompany({ zones, demo }: { zones: ZoneOption[]; demo: boolean }) {
  const [ready, setReady] = useState(false)
  const [step, setStep] = useState<Step>("intro")
  const [company, setCompany] = useState("")
  const [description, setDescription] = useState("")
  const [name, setName] = useState("")
  const [title, setTitle] = useState("")
  const [picked, setPicked] = useState<string[]>(DEFAULT_PICK)
  const [custom, setCustom] = useState<string[]>([])
  const [created, setCreated] = useState<Created | null>(null)
  const [invites, setInvites] = useState<Invite[]>([])
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [team, setTeam] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Claude Code ou Codex travaille en arrière-plan une fois le cerveau créé : on peut passer à la suite, ses
  // signaux arrivent en notifications et sa proposition rejoint l'étape des zones dès qu'il l'envoie.
  const agent = useAgentOnboarding<Proposal>(Boolean(created) && step !== "intro", step !== "context")
  const incoming = agent.draft

  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has(DRAFT_PARAM)) {
      clear()
      url.searchParams.set(DRAFT_PARAM, "1")
      window.history.replaceState(null, "", url)
    }
    const s = load()
    if (s) {
      if (s.step) setStep(s.step)
      setCompany(s.company ?? "")
      setDescription(s.description ?? "")
      setName(s.name ?? "")
      setTitle(s.title ?? "")
      if (s.picked) setPicked(s.picked)
      setCustom(s.custom ?? [])
      setCreated(s.created ?? null)
      setInvites(s.invites ?? [])
      setProposal(s.proposal ?? null)
    }
    setReady(true)
  }, [])

  useEffect(() => {
    if (ready) save({ step, company, description, name, title, picked, custom, created, invites, proposal })
  }, [ready, step, company, description, name, title, picked, custom, created, invites, proposal])

  // Une fois l'entreprise créée : qui s'est branché ? Relu régulièrement, la page se met à jour toute seule.
  useEffect(() => {
    if (!created) return
    let stop = false
    const tick = async () => {
      try {
        const r = await api<{ users: TeamUser[] }>("/api/admin/team")
        if (!stop) setTeam(Object.fromEntries(r.users.map((u) => [u.id, u.last_at])))
      } catch {}
    }
    void tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [created])

  // Une proposition (ou sa version complétée) arrive pendant l'étape des zones : elle s'y ajoute, sans retirer ce
  // que la personne a déjà coché ou décoché. Le choix par défaut, s'il n'a pas été touché, lui cède la place.
  useEffect(() => {
    if (step !== "zones" || !incoming || incoming.received_at === proposal?.received_at) return
    const before = new Set((proposal?.zones ?? []).map((z) => z.id))
    const ids = incoming.zones.map((z) => z.id)
    setProposal(incoming)
    setPicked((p) =>
      !proposal && p.join() === DEFAULT_PICK.join() ? ids : [...p, ...ids.filter((id) => !before.has(id) && !p.includes(id))],
    )
  }, [step, incoming, proposal])

  // Zones du brouillon, ou celles réellement créées : c'est ce que montre le petit cerveau à droite.
  // Connaissances proposées par zone : le cerveau de l'aperçu en a déjà, en billes.
  const proposalCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const i of (proposal?.items ?? []) as { zone?: string }[]) if (i.zone) out[i.zone] = (out[i.zone] ?? 0) + 1
    return out
  }, [proposal])
  // Pendant que Claude prépare sa proposition, pas encore de zone : le petit cerveau n'en montre aucune.
  const draftZones = useMemo<ZoneOption[]>(
    () => (created?.zones.length ? created.zones : step === "context" ? [] : draftZoneList(zones, picked, custom, proposal?.zones)),
    [zones, picked, custom, created, proposal, step],
  )

  const go = (s: Step) => {
    setErr(null)
    setStep(s)
  }

  /** Après « Et vous ? » : le cerveau est créé sans zone, pour que Claude puisse les proposer (code d'envoi lié à l'admin). */
  async function createOrg() {
    if (created) return go("context")
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ org: { name: string }; profile: { id: string }; prompt: string; zones: ZoneOption[]; token: string }>("/api/orgs", {
        method: "POST",
        json: { company, description, name, title, later: true },
      })
      setCreated({ orgName: r.org.name, meId: r.profile.id, prompt: r.prompt, zones: r.zones, token: r.token })
      setStep("context")
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  /** Proposition reçue (ou étape passée) : l'étape des zones part de ses zones, toutes cochées. */
  function toZones(p: Proposal | null) {
    setProposal(p)
    if (p?.zones.length) setPicked(p.zones.map((z) => z.id))
    go("zones")
  }

  /** Étape des zones : crée celles retenues, ajoute les connaissances proposées, et reçoit le prompt d'installation. */
  async function applyZones() {
    if (!created) return
    setBusy(true)
    setErr(null)
    try {
      const proposed = (proposal?.zones ?? []).filter((z) => picked.includes(z.id))
      const r = await api<{ zones: ZoneOption[]; prompt: string | null }>("/api/onboarding/zones", {
        method: "POST",
        json: {
          proposed,
          picked: picked.filter((id) => zones.some((z) => z.id === id) && !proposed.some((p) => p.id === id)),
          custom,
          items: proposal?.items ?? [],
          description: proposal?.description ?? "",
          token: created.token,
        },
      })
      // La proposition reste en mémoire : l'aperçu garde ses connaissances par zone.
      setCreated({ ...created, zones: r.zones, prompt: r.prompt ?? created.prompt })
      setStep("install")
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function restart() {
    if (created && !confirm(`Recommencer ? Le cerveau ${deNom(created.orgName)} reste en place, vous en créerez un nouveau.`)) return
    clear()
    setCompany("")
    setDescription("")
    setName("")
    setTitle("")
    setPicked(DEFAULT_PICK)
    setCustom([])
    setCreated(null)
    setInvites([])
    setProposal(null)
    setTeam({})
    go("company")
  }

  const index = STEPS.indexOf(step)
  const org = created?.orgName ?? (company.trim() || "votre entreprise")
  // Une fois le cerveau créé (après « Et vous ? »), plus de retour vers les questions qui l'ont nommé.
  const back: Partial<Record<Step, Step>> = { company: "intro", about: "company", you: "about", zones: "context", team: "install" }
  const people = created
    ? [{ id: created.meId, name, connected: Boolean(team[created.meId]) }, ...invites.map((i) => ({ id: i.id, name: i.name, connected: Boolean(team[i.id]) }))]
    : name.trim()
      ? [{ id: "me", name, connected: false }]
      : []

  return (
    <main className="create flex min-h-dvh flex-col">
      <header className="create-wrap flex items-center justify-between gap-4 py-4">
        <Link href="/" className="flex items-center gap-2.5 rounded-[6px]">
          <LogoMark size={26} />
          <span className="whitespace-nowrap text-[15px] font-medium">NOS Brainer</span>
        </Link>
        <div className="flex items-center gap-3 text-[13px] text-trace">
          {index >= 0 && (
            <span className="hidden whitespace-nowrap tabular-nums sm:inline">
              Étape {index + 1} sur {STEPS.length}
            </span>
          )}
          {created ? (
            <Link href="/dashboard" className="btn">
              Ouvrir le dashboard
            </Link>
          ) : (
            <Link href={demo ? "/demo" : "/login"} className="btn btn-ghost">
              {demo ? "Voir la démo" : "Se connecter"}
            </Link>
          )}
        </div>
      </header>
      <div className="create-progress" aria-hidden>
        <div className="create-progress-fill" style={{ transform: `scaleX(${index < 0 ? 0 : (index + 1) / STEPS.length})` }} />
      </div>

      <div className="create-wrap grid flex-1 gap-12 py-[clamp(40px,9vh,112px)] lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-20">
        <section className="min-w-0 max-w-[640px]" aria-live="polite">
          {!ready ? null : (
            <div key={step} className="step-in">
              {back[step] && (
                <button type="button" className="mb-8 text-[13px] text-trace hover:text-ink" onClick={() => go(back[step]!)}>
                  Retour
                </button>
              )}

              {step === "intro" && (
                <>
                  <h1 className="create-title">Créons le cerveau de votre entreprise.</h1>
                  <p className="create-lead">
                    Trois questions pour monter votre dashboard, puis Claude Code ou Codex peut proposer ses zones à partir de vos conversations. Ensuite, un message
                    branche votre poste, et un message par collègue les fait rejoindre le cerveau. Quelques minutes en tout.
                  </p>
                  <div className="mt-9 flex flex-wrap items-center gap-3">
                    <button type="button" className="btn btn-primary btn-lg" onClick={() => go("company")} autoFocus>
                      Commencer
                    </button>
                    {demo && (
                      <Link href="/demo" className="btn btn-lg">
                        Voir d'abord la démo
                      </Link>
                    )}
                  </div>
                </>
              )}

              {step === "company" && (
                <Question
                  title="Comment s'appelle votre entreprise ?"
                  onSubmit={() => go("about")}
                  canContinue={company.trim().length > 0}
                >
                  <input
                    className="create-input"
                    value={company}
                    maxLength={80}
                    autoFocus
                    aria-label="Nom de l'entreprise"
                    placeholder="Butine"
                    onChange={(e) => setCompany(e.target.value)}
                  />
                </Question>
              )}

              {step === "about" && (
                <Question
                  title={`Que fait ${org}, en une phrase ?`}
                  lead="Le cerveau s'en sert pour situer ce qu'il apprend. Facultatif."
                  onSubmit={() => go("you")}
                  canContinue
                  skip={description.trim() ? undefined : () => go("you")}
                >
                  <textarea
                    className="create-input create-textarea"
                    value={description}
                    maxLength={300}
                    rows={2}
                    autoFocus
                    aria-label="Activité de l'entreprise"
                    placeholder="Des balances connectées pour ruches : l'apiculteur suit ses abeilles depuis son téléphone."
                    onChange={(e) => setDescription(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault()
                        go("you")
                      }
                    }}
                  />
                </Question>
              )}

              {step === "you" && (
                <Question
                  title="Et vous ?"
                  lead="Vous serez admin du cerveau : c'est vous qui choisissez qui voit quoi."
                  onSubmit={createOrg}
                  canContinue={name.trim().length > 0 && !busy}
                >
                  <div className="space-y-5">
                    <input
                      className="create-input"
                      value={name}
                      maxLength={80}
                      autoFocus
                      aria-label="Votre nom"
                      placeholder="Votre nom"
                      autoComplete="name"
                      onChange={(e) => setName(e.target.value)}
                    />
                    <input
                      className="create-input create-input-sm"
                      value={title}
                      maxLength={80}
                      aria-label="Votre rôle"
                      placeholder="Votre rôle : CEO, CTO, office manager…"
                      autoComplete="organization-title"
                      onChange={(e) => setTitle(e.target.value)}
                    />
                    {busy && <p className="text-[13px] text-trace">Création du cerveau…</p>}
                    {err && <ErrorText>{err}</ErrorText>}
                  </div>
                </Question>
              )}

              {step === "context" && created && <ContextStep orgName={created.orgName} run={agent.run} state={agent.state} received={incoming} onNext={toZones} />}

              {step === "zones" && created && (
                <ZonesStep
                  org={org}
                  zones={zones}
                  proposal={proposal}
                  agentBusy={agent.state === "running"}
                  preview={draftZones}
                  picked={picked}
                  setPicked={setPicked}
                  custom={custom}
                  setCustom={setCustom}
                  busy={busy}
                  err={err}
                  onCreate={applyZones}
                />
              )}

              {step === "install" && created && (
                <>
                  <h1 className="create-title">Le cerveau {deNom(created.orgName)} est prêt.</h1>
                  <p className="create-lead">
                    Branchez votre poste : ouvrez ce message dans Claude Code ou Codex. Il installe Screenpipe, branche le MCP et les hooks, puis ouvre votre dashboard déjà
                    connecté. Sur Mac, il faudra autoriser l'enregistrement de l'écran.
                  </p>
                  <div className="panel mt-8 px-5 py-5">
                    <PromptActions getPrompt={() => Promise.resolve(created.prompt)} />
                    <p className="mt-4 border-t border-line pt-4 text-[13px] leading-relaxed text-trace">
                      Ce message contient votre jeton personnel : gardez-le pour vous. Aucun historique n'est envoyé, le cerveau apprend à partir de l'installation.
                    </p>
                  </div>
                  <Presence connected={Boolean(team[created.meId])} self />
                  <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
                    <button type="button" className="btn btn-lg" onClick={() => go("team")}>
                      Continuer
                    </button>
                    <Link href="/dashboard" className="landing-link text-[15px]">
                      Ouvrir le dashboard
                    </Link>
                  </div>
                </>
              )}

              {step === "team" && created && (
                <TeamStep created={created} invites={invites} setInvites={setInvites} team={team} />
              )}

              {(step === "context" || step === "zones" || step === "install" || step === "team") && !created && (
                <>
                  <h1 className="create-title">Cette page a perdu votre cerveau.</h1>
                  <p className="create-lead">Il existe toujours : retrouvez-le depuis le dashboard, ou recommencez.</p>
                  <div className="mt-9 flex flex-wrap gap-3">
                    <Link href="/dashboard" className="btn btn-primary btn-lg">
                      Ouvrir le dashboard
                    </Link>
                    <button type="button" className="btn btn-lg" onClick={restart}>
                      Recommencer
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        <aside className="hidden lg:block" aria-label={`Aperçu du cerveau ${deNom(org)}`}>
          <div className="sticky top-10">
            <MiniBrain org={org} zones={draftZones} people={people} counts={proposalCounts} />
            {created && step !== "intro" && (
              <p className="mt-6 text-center text-[13px] text-trace">
                <button type="button" className="hover:text-ink" onClick={restart}>
                  Créer une autre entreprise
                </button>
              </p>
            )}
          </div>
        </aside>
      </div>
      {/* À l'étape « context », le fil est déjà dans la page. Après les zones, la proposition se relit dans Onboarding. */}
      {step !== "context" && (
        <AgentToasts
          toasts={agent.toasts}
          dismiss={agent.dismiss}
          draftAction={
            step === "install" || step === "team" ? (
              <Link href="/onboarding" className="landing-link">
                La relire dans Onboarding
              </Link>
            ) : undefined
          }
        />
      )}
    </main>
  )
}

/**
 * Avant les zones (facultatif) : Claude Code ou Codex relit les conversations du poste qui concernent l'entreprise (son
 * nom et sa description, et rien d'autre), puis propose zones et premières connaissances (POST /api/onboarding/import).
 * La page la reçoit en direct ; l'étape des zones part de cette proposition. On peut passer et choisir soi-même.
 */
function ContextStep(props: { orgName: string; run: AgentEvent[]; state: RunState; received: Proposal | null; onNext: (p: Proposal | null) => void }) {
  const { orgName, run, state, received, onNext } = props
  const prompt = useRef<Promise<string> | null>(null)

  const getPrompt = () => {
    prompt.current ??= api<{ prompt: string }>("/api/onboarding/agent", { method: "POST" }).then((r) => r.prompt)
    prompt.current.catch(() => (prompt.current = null))
    return prompt.current
  }

  const started = state !== "idle"
  return (
    <>
      <h1 className="create-title">Laissez Claude proposer les zones.</h1>
      <p className="create-lead">
        Ouvrez ce message dans Claude Code ou Codex. Il relit vos conversations sur ce poste qui concernent {orgName}, et seulement elles, puis propose les zones
        du cerveau et ses premières connaissances. Il vous demande votre accord avant de lire quoi que ce soit, et vous relisez tout à l&apos;étape suivante.
      </p>
      <div className="panel mt-8 px-5 py-5">
        <PromptActions getPrompt={getPrompt} sends />
        <p className="mt-4 border-t border-line pt-4 text-[13px] leading-relaxed text-trace">
          Claude Code ou Codex, au choix. Jamais de secrets ni de données personnelles ; le code d&apos;envoi qu&apos;il contient vaut 2 heures.
        </p>
      </div>
      {received ? (
        <p className="mt-6 flex items-center gap-2 text-[14px]" aria-live="polite">
          <span className="live-dot is-live" aria-hidden />
          Proposition reçue : {received.zones.length} zone{received.zones.length > 1 ? "s" : ""}, {received.items.length} connaissance
          {received.items.length > 1 ? "s" : ""}.{state === "running" && " Claude continue de la compléter : l'étape suivante suivra."}
        </p>
      ) : started ? (
        <p className="mt-6 text-[14px]" aria-live="polite">
          {state === "error"
            ? "Claude s'est arrêté avant d'envoyer sa proposition. Relancez le message, ou choisissez les zones vous-même."
            : "C'est lancé. Vous pouvez passer à la suite : Claude continue en arrière-plan, ses zones s'ajouteront à l'étape suivante dès qu'il les envoie, et chaque trouvaille s'affiche en notification."}
        </p>
      ) : (
        <p className="mt-6 flex items-center gap-2 text-[14px]" aria-live="polite">
          <span className="live-dot" aria-hidden /> En attente de Claude. Cette page se met à jour toute seule.
        </p>
      )}
      <AgentRun run={run} className="mt-4" />
      <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
        {received && (
          <button type="button" className="btn btn-primary btn-lg" onClick={() => onNext(received)}>
            Voir les zones proposées
          </button>
        )}
        {!received && started && state !== "error" && (
          <button type="button" className="btn btn-primary btn-lg" onClick={() => onNext(null)}>
            Continuer pendant que Claude travaille
          </button>
        )}
        <button type="button" className={received || (started && state !== "error") ? "landing-link text-[15px]" : "btn btn-lg"} onClick={() => onNext(null)}>
          {received ? "Ignorer et choisir moi-même" : started && state !== "error" ? "Choisir les zones sans attendre Claude" : "Passer : je choisis les zones moi-même"}
        </button>
      </div>
    </>
  )
}

/** Une question par écran : titre, aide, champ, puis « Continuer » (ou Entrée). */
function Question(props: { title: string; lead?: string; children: React.ReactNode; onSubmit: () => void; canContinue: boolean; skip?: () => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (props.canContinue) props.onSubmit()
      }}
    >
      <h1 className="create-title">{props.title}</h1>
      {props.lead && <p className="create-lead">{props.lead}</p>}
      <div className="mt-9">{props.children}</div>
      <div className="mt-9 flex flex-wrap items-center gap-4">
        <button type="submit" className="btn btn-primary btn-lg" disabled={!props.canContinue}>
          Continuer
        </button>
        {props.skip ? (
          <button type="button" className="landing-link text-[15px]" onClick={props.skip}>
            Passer
          </button>
        ) : (
          <span className="hidden text-[13px] text-trace sm:inline">ou appuyez sur Entrée</span>
        )}
      </div>
    </form>
  )
}

function ZonesStep(props: {
  org: string
  zones: ZoneOption[]
  proposal: Proposal | null
  /** Claude travaille encore : sa proposition (ou sa version complétée) s'ajoutera à cette étape. */
  agentBusy: boolean
  preview: ZoneOption[]
  picked: string[]
  setPicked: (f: (p: string[]) => string[]) => void
  custom: string[]
  setCustom: (f: (c: string[]) => string[]) => void
  busy: boolean
  err: string | null
  onCreate: () => void
}) {
  const [draft, setDraft] = useState("")
  const count = props.picked.length + props.custom.length
  const toggle = (id: string) => props.setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const proposed = props.proposal?.zones ?? []
  const others = props.zones.filter((z) => !proposed.some((p) => p.id === z.id))
  const items = props.proposal?.items.length ?? 0
  const option = (z: { id: string; name: string; description: string }, color: string) => {
    const on = props.picked.includes(z.id)
    return (
      <button key={z.id} type="button" className="zone-option" aria-pressed={on} onClick={() => toggle(z.id)}>
        <span className="flex items-center justify-between gap-2">
          <ZoneTag name={z.name} color={color} className="text-[15px] font-medium" />
          <span className={`zone-check ${on ? "is-on" : ""}`} aria-hidden>
            {on && <CheckIcon size={12} />}
          </span>
        </span>
        <span className="mt-1 block text-[13px] leading-snug text-trace">{z.description}</span>
      </button>
    )
  }
  const addCustom = () => {
    const v = draft.trim()
    if (!v) return
    const id = slugify(v)
    if (!props.zones.some((z) => z.id === id) && !props.custom.some((c) => slugify(c) === id)) props.setCustom((c) => [...c, v].slice(0, 8))
    else if (props.zones.some((z) => z.id === id)) props.setPicked((p) => (p.includes(id) ? p : [...p, id]))
    setDraft("")
  }

  return (
    <div>
      <h1 className="create-title">Que doit connaître le cerveau {deNom(props.org)} ?</h1>
      <p className="create-lead">
        {proposed.length
          ? "Claude les a proposées à partir de vos conversations : gardez, retirez, ajoutez. Vous réglerez ensuite qui lit quelle zone."
          : "Une zone par métier. Vous réglerez ensuite qui lit quelle zone : la compta n'a pas besoin du code."}
      </p>
      {props.agentBusy && (
        <p className="mt-4 flex items-center gap-2 text-[13px] text-trace" aria-live="polite">
          <span className="live-dot is-live" aria-hidden />
          {proposed.length ? "Claude complète encore sa proposition : ses nouvelles zones s'ajouteront ici." : "Claude prépare encore ses zones : elles s'ajouteront ici dès qu'il les envoie."}
        </p>
      )}
      {proposed.length > 0 && (
        <>
          <h2 className="mt-9 text-[13px] font-medium text-trace">Proposées par Claude</h2>
          <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">{proposed.map((z, i) => option(z, ZONE_PALETTE[i % ZONE_PALETTE.length]))}</div>
          <h2 className="mt-8 text-[13px] font-medium text-trace">Autres zones</h2>
        </>
      )}
      <div className={`${proposed.length ? "mt-3" : "mt-9"} grid grid-cols-1 gap-2.5 sm:grid-cols-2`}>
        {others.map((z) => option(z, zoneColor(z.color, z.position)))}
      </div>

      <div className="mt-5">
        {props.custom.length > 0 && (
          <ul className="mb-3 flex flex-wrap gap-1.5" aria-label="Zones ajoutées">
            {props.custom.map((c, i) => (
              <li key={c} className="chip h-7 pr-1 text-[13px]">
                <Dot color={props.preview.find((z) => z.name === c)?.color ?? zoneColor(null, props.zones.length + i)} />
                {c}
                <button
                  type="button"
                  className="grid size-5 place-items-center rounded-[4px] text-trace hover:text-ink"
                  aria-label={`Retirer la zone ${c}`}
                  onClick={() => props.setCustom((list) => list.filter((x) => x !== c))}
                >
                  <CloseIcon size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex max-w-[420px] gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            addCustom()
          }}
        >
          <input
            className="input"
            value={draft}
            maxLength={40}
            aria-label="Ajouter une zone"
            placeholder="Ajouter une zone : juridique, ops, recrutement…"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="btn btn-icon h-9 w-9 shrink-0" aria-label="Ajouter cette zone" disabled={!draft.trim() || props.custom.length >= 8}>
            <PlusIcon />
          </button>
        </form>
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-4">
        <button type="button" className="btn btn-primary btn-lg" onClick={props.onCreate} disabled={props.busy || count === 0}>
          {props.busy ? "Création des zones…" : "Valider les zones"}
        </button>
        <span className="text-[13px] tabular-nums text-trace">
          {count === 0
            ? "Choisissez au moins une zone."
            : `${count} zone${count > 1 ? "s" : ""}${items ? `, ${items} connaissance${items > 1 ? "s" : ""} proposée${items > 1 ? "s" : ""} ajoutée${items > 1 ? "s" : ""} au cerveau` : ""}`}
        </span>
      </div>
      {props.err && <ErrorText className="mt-3">{props.err}</ErrorText>}
    </div>
  )
}

function TeamStep(props: { created: Created; invites: Invite[]; setInvites: (f: (i: Invite[]) => Invite[]) => void; team: Record<string, string | null> }) {
  const { created, invites } = props
  const [name, setName] = useState("")
  const [title, setTitle] = useState("")
  const [zones, setZones] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  async function invite(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ profile: { id: string; name: string; title?: string }; prompt: string }>("/api/admin/users", {
        method: "POST",
        json: { name: name.trim(), title: title.trim() || undefined, role: "member", zones, manager_id: created.meId },
      })
      props.setInvites((list) => [{ id: r.profile.id, name: r.profile.name, title: r.profile.title, zones, prompt: r.prompt }, ...list])
      setName("")
      setTitle("")
      setZones([])
      await copy(r.profile.id, r.prompt)
      nameRef.current?.focus()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function copy(id: string, prompt: string) {
    try {
      await copyText(prompt)
      setCopied(id)
    } catch {
      setErr("Copie impossible : votre navigateur l'a refusée.")
    }
  }

  const zone = (id: string) => created.zones.find((z) => z.id === id)

  return (
    <div>
      <h1 className="create-title">Invitez l'équipe {deNom(created.orgName)}.</h1>
      <p className="create-lead">
        Deux façons, au choix : un message par personne, avec son propre jeton, ou un seul message pour toute l'équipe, où chacun demande à entrer. Dans les deux
        cas, il se colle dans Claude Code ou Codex, et le poste apparaît ici dès qu'il est branché au cerveau {deNom(created.orgName)}.
      </p>
      <h2 className="mt-10 text-[19px] font-medium">Un message par personne</h2>

      <form onSubmit={invite} className="panel mt-4 space-y-4 px-5 py-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <input ref={nameRef} className="input" value={name} maxLength={80} aria-label="Nom" placeholder="Prénom Nom" onChange={(e) => setName(e.target.value)} />
          <input className="input" value={title} maxLength={80} aria-label="Rôle" placeholder="Rôle : dev, compta, sales…" onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <p className="text-[13px] text-trace">Zones qu'elle peut lire</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {created.zones.map((z) => {
              const on = zones.includes(z.id)
              return (
                <button
                  key={z.id}
                  type="button"
                  className={`chip h-7 text-[13px] ${on ? "chip-on" : ""}`}
                  aria-pressed={on}
                  onClick={() => setZones((list) => (on ? list.filter((x) => x !== z.id) : [...list, z.id]))}
                >
                  <Dot color={zoneColor(z.color, z.position)} />
                  {z.name}
                </button>
              )
            })}
          </div>
          {zones.length === 0 && <p className="mt-2 text-[12px] text-trace">Sans zone, elle nourrit le cerveau mais n'en lit rien.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? (
              "Création du prompt…"
            ) : (
              <>
                <AgentLogos /> Créer et copier son prompt
              </>
            )}
          </button>
          {err && <ErrorText>{err}</ErrorText>}
        </div>
      </form>

      {invites.length > 0 && (
        <ul className="mt-6 divide-y divide-line border-y border-line" aria-label="Personnes invitées">
          {invites.map((i) => {
            const connected = Boolean(props.team[i.id])
            const first = i.zones.length > 0 ? zone(i.zones[0]) : undefined
            return (
              <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5">
                <span className="relative shrink-0">
                  <PersonAvatar id={i.id} size={36} bg="surface" color={first ? zoneColor(first.color, first.position) : undefined} />
                  <span className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border border-ink ${connected ? "bg-phosphor" : "bg-surface"}`} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">{i.name}</p>
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-trace">
                    <span>{connected ? "Connecté" : "En attente de son poste"}</span>
                    {i.zones.map((zid) => {
                      const z = zone(zid)
                      return z ? <ZoneTag key={zid} name={z.name} color={zoneColor(z.color, z.position)} /> : null
                    })}
                  </p>
                </div>
                {i.prompt ? (
                  <button type="button" className="btn" onClick={() => copy(i.id, i.prompt)}>
                    {copied === i.id ? (
                      <>
                        <CheckIcon size={14} /> Copié
                      </>
                    ) : (
                      "Copier son prompt"
                    )}
                  </button>
                ) : (
                  <span className="text-[12px] text-trace">Par le message d'équipe</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {copied && <p className="mt-3 text-[13px] text-trace" aria-live="polite">Prompt copié : envoyez-le-lui (Slack, mail), il le colle dans Claude Code ou Codex.</p>}

      <h2 className="mt-12 text-[19px] font-medium">Ou un seul message pour toute l'équipe</h2>
      <div className="mt-3">
        <TeamJoin
          compact
          orgName={created.orgName}
          zones={created.zones}
          defaultManager={created.meId}
          onAccepted={(p) => props.setInvites((list) => [{ ...p, prompt: "" }, ...list])}
        />
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Link href="/dashboard" className="btn btn-lg">
          Ouvrir le dashboard
        </Link>
        <Presence connected={Boolean(props.team[created.meId])} self compact />
      </div>
    </div>
  )
}

/** Où en est le branchement d'un poste : en attente (témoin vide), ou connecté (témoin allumé). */
function Presence({ connected, self, compact = false }: { connected: boolean; self?: boolean; compact?: boolean }) {
  return (
    <p className={`flex items-center gap-2 text-[14px] ${compact ? "" : "mt-6"}`} aria-live="polite">
      <span className={`live-dot ${connected ? "is-live" : ""}`} aria-hidden />
      {connected
        ? self
          ? "Votre poste est connecté. Le cerveau s'allume à chaque session Claude Code."
          : "Connecté."
        : self
          ? compact
            ? "Votre poste n'est pas encore branché."
            : "En attente de votre poste. Cette page se met à jour toute seule."
          : "En attente."}
    </p>
  )
}

/**
 * Le cerveau en train de se construire, dans la langue du dashboard : un centre, une bille par zone reliée au centre,
 * et les personnes autour (pleines une fois leur poste branché).
 */
/**
 * Le cerveau de l'entreprise en train de naître : le même cerveau 3D que le dashboard et la landing, sans ses
 * commandes. Chaque zone qui apparaît s'allume un instant ; les personnes y prennent place une fois le cerveau créé.
 */
function MiniBrain(props: { org: string; zones: ZoneOption[]; people: { id: string; name: string; connected: boolean }[]; counts: Record<string, number> }) {
  const { org, zones, people, counts } = props
  const views = useMemo<ZoneView[]>(
    () => zones.map((z) => ({ ...z, keywords: [], count: counts[z.id] ?? 0, last_at: null, contributors: 0, locked: false, entities: [] })),
    [zones, counts],
  )
  const [now, setNow] = useState(() => Date.now())
  const [activity, setActivity] = useState<Record<string, ZoneActivity>>({})
  const seen = useRef(new Set<string>())
  useEffect(() => {
    const t = Date.now()
    const fresh = zones.filter((z) => !seen.current.has(z.id))
    for (const z of fresh) seen.current.add(z.id)
    if (fresh.length) setActivity((a) => ({ ...a, ...Object.fromEntries(fresh.map((z) => [z.id, { until: t + 1800, startedAt: t }])) }))
  }, [zones])
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [])
  // Un dot par personne déjà créée (pas avant : il mène à sa page), posé au bord de la première zone.
  const dots: BrainPerson[] = people
    .filter((p) => p.id !== "me")
    .map((p, i) => ({ id: p.id, name: p.name, zone: zones[0]?.id ?? null, working: p.connected, me: i === 0 }))
  const connected = people.filter((p) => p.connected).length
  return (
    <figure>
      <div className="relative h-[min(62vh,520px)] w-full">
        <Brain3D zones={views} synapses={[]} activity={activity} ripples={[]} now={now} people={dots} controls={false} paper={BONE} />
      </div>
      <figcaption className="mt-2 text-center">
        <span className="block text-[17px] font-medium">{org.charAt(0).toUpperCase() + org.slice(1)}</span>
        <span className="text-[13px] tabular-nums text-trace">
          {zones.length} zone{zones.length > 1 ? "s" : ""}
          {people.length > 0 && `, ${connected} poste${connected > 1 ? "s" : ""} branché${connected > 1 ? "s" : ""} sur ${people.length}`}
        </span>
      </figcaption>
    </figure>
  )
}
