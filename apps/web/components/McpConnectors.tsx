"use client"

import { Fragment, createContext, useContext, useEffect, useState } from "react"
import { MCP_CATALOG, MCP_CATEGORIES, catalogEntry, type McpCatalogEntry, type McpCategory, type McpConnectorPublic, type McpReturn } from "@brain/core"
import { fmt } from "@/lib/i18n"
import { api, errorMessage } from "./format"
import { useT } from "./I18n"
import { McpLogo } from "./mcp-logos"
import { RelTime } from "./RelTime"
import { ErrorText } from "./ui"

type Props = {
  initial: McpConnectorPublic[]
  redirectUri: string
  /** Page où revenir après la connexion chez le fournisseur (par défaut : Connecteurs). */
  returnTo?: McpReturn
  /** Sans titre ni introduction (la page qui l'accueille a les siens : étape 8 de /creer). */
  bare?: boolean
}

const ReturnTo = createContext<McpReturn>("connecteurs")

const CUSTOM_COLOR = "#52525B"
/** Serveurs du catalogue montrés avant « Voir les … autres ». */
const PREVIEW = 9

/** Serveurs MCP : ceux déjà branchés, puis le catalogue (recherche, catégories) et l'ajout d'un serveur quelconque. */
export function McpConnectors({ initial, redirectUri, returnTo = "connecteurs", bare = false }: Props) {
  const { t } = useT()
  const k = t.connectors.mcp
  const [items, setItems] = useState(initial)
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<McpCategory | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [showAll, setShowAll] = useState(false)

  // Retour de la page de connexion du fournisseur (?mcp=connected&id=… ou ?mcp=error&reason=…).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const outcome = q.get("mcp")
    if (!outcome) return
    if (outcome === "connected") {
      const id = q.get("id") ?? ""
      const c = initial.find((x) => x.id === id)
      setNotice(c?.status === "error" ? { ok: false, text: fmt(k.failed, { error: c.last_check?.error ?? "?" }) } : { ok: true, text: fmt(k.connected, { name: c?.name ?? id }) })
    } else setNotice({ ok: false, text: fmt(k.failed, { error: q.get("reason") ?? "?" }) })
    // On retire seulement nos paramètres (/creer garde son ?brouillon=1, qui reprend le parcours au rechargement).
    const url = new URL(window.location.href)
    for (const key of ["mcp", "id", "reason"]) url.searchParams.delete(key)
    window.history.replaceState(null, "", url)
  }, [initial, k.connected, k.failed])

  function upsert(next: McpConnectorPublic) {
    setItems((prev) => (prev.some((c) => c.id === next.id) ? prev.map((c) => (c.id === next.id ? next : c)) : [...prev, next]))
  }
  function drop(id: string) {
    setItems((prev) => prev.filter((c) => c.id !== id))
  }

  const added = new Set(items.map((c) => c.id))
  const needle = query.trim().toLowerCase()
  const catalog = MCP_CATALOG.filter((e) => !added.has(e.id))
    .filter((e) => !category || e.category === category)
    .filter((e) => !needle || `${e.name} ${e.description.fr} ${e.description.en} ${e.id}`.toLowerCase().includes(needle))
  // Sans recherche ni catégorie, un aperçu (la liste complète fait plusieurs écrans sur mobile).
  const collapsed = !showAll && !needle && !category && catalog.length > PREVIEW + 3

  return (
    <ReturnTo.Provider value={returnTo}>
      <div className="space-y-4">
        {!bare && (
          <div>
            <h2 className="text-[18px] font-medium leading-tight">{k.title}</h2>
            <p className="mt-1 max-w-3xl text-[13px] text-trace">{k.lead}</p>
          </div>
        )}
        {notice && (
          <div role="status" className={`panel flex items-start justify-between gap-3 px-4 py-3 text-[13px] ${notice.ok ? "" : "text-danger"}`}>
            <span>{notice.text}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNotice(null)} aria-label="OK">
              ×
            </button>
          </div>
        )}

        {items.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-[13px] font-medium text-trace">{k.added}</h3>
            <div className="grid items-start gap-3 md:grid-cols-2">
              {items.map((c) => (
                <AddedCard key={c.id} connector={c} redirectUri={redirectUri} onChange={upsert} onRemoved={drop} />
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <h3 className="text-[13px] font-medium text-trace">{k.catalog}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input className="input input-sm !w-64 max-w-full" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={k.search} aria-label={k.search} autoComplete="off" />
            <div className="flex flex-wrap gap-1" role="group">
              <button type="button" className={`chip ${category === null ? "chip-on" : ""}`} aria-pressed={category === null} onClick={() => setCategory(null)}>
                {k.allCategories}
              </button>
              {MCP_CATEGORIES.map((cat) => (
                <button key={cat} type="button" className={`chip ${category === cat ? "chip-on" : ""}`} aria-pressed={category === cat} onClick={() => setCategory(category === cat ? null : cat)}>
                  {k.categories[cat]}
                </button>
              ))}
            </div>
          </div>
          {catalog.length === 0 ? (
            <p className="text-[13px] text-trace">{k.noResult}</p>
          ) : (
            <>
              <div className={`grid items-start gap-3 sm:grid-cols-2 ${bare ? "" : "xl:grid-cols-3"}`}>
                {(collapsed ? catalog.slice(0, PREVIEW) : catalog).map((e) => (
                  <CatalogTile key={e.id} entry={e} redirectUri={redirectUri} onAdded={upsert} />
                ))}
              </div>
              {collapsed && (
                <button type="button" className="btn btn-sm" onClick={() => setShowAll(true)}>
                  {fmt(k.showAll, { n: catalog.length - PREVIEW })}
                </button>
              )}
            </>
          )}
        </div>

        <CustomServer onAdded={upsert} />
      </div>
    </ReturnTo.Provider>
  )
}

/** Redirige vers la page de connexion du fournisseur (après découverte, enregistrement du client et PKCE côté serveur). */
async function authorize(id: string, returnTo: McpReturn): Promise<void> {
  const { url } = await api<{ url: string }>(`/api/connectors/mcp/${encodeURIComponent(id)}/authorize`, { method: "POST", json: { return_to: returnTo } })
  window.location.assign(url)
}

function Description({ entry }: { entry?: McpCatalogEntry }) {
  const { locale } = useT()
  if (!entry) return null
  return <p className="text-[12px] leading-snug text-trace">{entry.description[locale]}</p>
}

function CatalogTile({ entry, redirectUri, onAdded }: { entry: McpCatalogEntry; redirectUri: string; onAdded: (c: McpConnectorPublic) => void }) {
  const returnTo = useContext(ReturnTo)
  const { t } = useT()
  const k = t.connectors.mcp
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function primary() {
    setErr(null)
    if (entry.auth === "manual") return setOpen((o) => !o)
    setBusy(true)
    try {
      if (entry.auth === "dynamic") return await authorize(entry.id, returnTo)
      onAdded(await api<McpConnectorPublic>("/api/connectors/mcp", { method: "POST", json: { catalog_id: entry.id } }))
    } catch (e) {
      setErr(fmt(k.failed, { error: errorMessage(e) }))
    }
    setBusy(false)
  }

  return (
    <section className="panel flex flex-col gap-2.5 p-3.5" aria-busy={busy}>
      <div className="flex items-start gap-3">
        <McpLogo logo={entry.logo} name={entry.name} color={entry.color} />
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-[14px] font-medium leading-tight">{entry.name}</h4>
          <p className="mt-0.5 text-[11px] text-trace">{k.auth[entry.auth]}</p>
        </div>
        <button type="button" className={`btn btn-sm ${entry.auth === "manual" ? "" : "btn-primary"}`} onClick={primary} disabled={busy}>
          {busy ? k.redirecting : entry.auth === "none" ? k.add : entry.auth === "manual" ? k.configure : k.connect}
        </button>
      </div>
      <Description entry={entry} />
      {err && <ErrorText>{err}</ErrorText>}
      {open && <ManualSetup id={entry.id} entry={entry} redirectUri={redirectUri} hasClient={false} onSaved={onAdded} />}
    </section>
  )
}

function AddedCard({ connector: c, redirectUri, onChange, onRemoved }: { connector: McpConnectorPublic; redirectUri: string; onChange: (c: McpConnectorPublic) => void; onRemoved: (id: string) => void }) {
  const returnTo = useContext(ReturnTo)
  const { t } = useT()
  const k = t.connectors.mcp
  const entry = c.catalog_id ? catalogEntry(c.catalog_id) : undefined
  const [busy, setBusy] = useState<"test" | "auth" | "remove" | null>(null)
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const oauth = c.auth === "dynamic" || c.auth === "manual"

  async function run(kind: "test" | "auth" | "remove") {
    setBusy(kind)
    setErr(null)
    try {
      if (kind === "auth") {
        if (c.auth === "manual" && !c.has_client) {
          setOpen(true)
          setBusy(null)
          return
        }
        return await authorize(c.id, returnTo)
      }
      if (kind === "remove") {
        await api(`/api/connectors/mcp/${encodeURIComponent(c.id)}`, { method: "DELETE" })
        return onRemoved(c.id)
      }
      onChange(await api<McpConnectorPublic>(`/api/connectors/mcp/${encodeURIComponent(c.id)}/test`, { method: "POST" }))
    } catch (e) {
      setErr(fmt(k.actionError, { error: errorMessage(e) }))
    }
    setBusy(null)
  }

  const check = c.last_check
  const statusText = !c.enabled ? k.paused : k.status[c.status]
  return (
    <section className="panel flex flex-col gap-2.5 p-4" aria-busy={busy !== null}>
      <div className="flex items-start gap-3">
        <McpLogo logo={entry?.logo} name={c.name} color={entry?.color ?? CUSTOM_COLOR} />
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-[14px] font-medium leading-tight">{c.name}</h4>
          <p className="mono mt-0.5 truncate text-[11px] text-trace" title={c.url}>
            {c.url}
          </p>
        </div>
        <span className={`chip ${c.status === "connected" && c.enabled ? "chip-on" : ""} ${c.status === "error" ? "text-danger" : ""}`}>{statusText}</span>
      </div>
      <Description entry={entry} />
      {check?.ok && check.tools.length > 0 && (
        <p className="text-[12px] text-trace">
          <span className="font-medium text-ink">{fmt(k.tools, { n: check.tools.length })}</span>
          {" · "}
          <span className="mono">{check.tools.slice(0, 6).join(", ")}</span>
          {check.tools.length > 6 ? "…" : ""}
        </p>
      )}
      {check && !check.ok && <ErrorText>{check.error}</ErrorText>}
      {err && <ErrorText>{err}</ErrorText>}
      {open && c.auth === "manual" && <ManualSetup id={c.id} entry={entry} redirectUri={redirectUri} hasClient={c.has_client} onSaved={onChange} />}
      <div className="mt-auto flex flex-wrap items-center gap-2">
        {oauth && (
          <button type="button" className={`btn btn-sm ${c.status === "needs_auth" ? "btn-primary" : ""}`} onClick={() => run("auth")} disabled={busy !== null}>
            {busy === "auth" ? k.redirecting : c.status === "needs_auth" ? k.connect : k.reconnect}
          </button>
        )}
        {c.auth === "manual" && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)} disabled={busy !== null}>
            {k.configure}
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={() => run("test")} disabled={busy !== null || c.status === "needs_auth"}>
          {busy === "test" ? k.testing : k.test}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => run("remove")} disabled={busy !== null}>
          {k.remove}
        </button>
        <span className="ml-auto text-[12px] text-trace">
          {check ? (
            <>
              {k.lastCheck} : <RelTime iso={check.at} />
            </>
          ) : (
            k.neverChecked
          )}
        </span>
      </div>
    </section>
  )
}

/** Fournisseur sans enregistrement automatique : application OAuth déclarée à la main (ou jeton personnel si accepté). */
function ManualSetup({ id, entry, redirectUri, hasClient, onSaved }: { id: string; entry?: McpCatalogEntry; redirectUri: string; hasClient: boolean; onSaved: (c: McpConnectorPublic) => void }) {
  const returnTo = useContext(ReturnTo)
  const { t } = useT()
  const k = t.connectors.mcp
  const [clientId, setClientId] = useState("")
  const [secret, setSecret] = useState("")
  const [token, setToken] = useState("")
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState<"oauth" | "token" | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const path = `/api/connectors/mcp/${encodeURIComponent(id)}`

  async function saveClient() {
    setBusy("oauth")
    setErr(null)
    try {
      onSaved(await api<McpConnectorPublic>(path, { method: "PUT", json: { client_id: clientId, client_secret: secret || undefined } }))
      await authorize(id, returnTo)
    } catch (e) {
      setErr(fmt(k.failed, { error: errorMessage(e) }))
      setBusy(null)
    }
  }

  async function saveToken() {
    setBusy("token")
    setErr(null)
    try {
      await api(path, { method: "PUT", json: { token } })
      onSaved(await api<McpConnectorPublic>(`${path}/test`, { method: "POST" }))
      setToken("")
    } catch (e) {
      setErr(fmt(k.failed, { error: errorMessage(e) }))
    }
    setBusy(null)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(redirectUri)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // presse-papiers refusé : l'adresse reste sélectionnable
    }
  }

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="text-[12px] text-trace">{fmt(k.manualHelp, { name: entry?.name ?? id })}</p>
      {entry?.setup_url && (
        <a className="inline-block text-[12px] font-medium underline" href={entry.setup_url} target="_blank" rel="noreferrer">
          {k.createApp} ↗
        </a>
      )}
      <label className="block text-[12px] font-medium">{k.redirectUri}</label>
      <div className="flex items-start gap-2">
        <code className="mono min-w-0 flex-1 select-all rounded-[6px] border border-line bg-bone px-2 py-1.5 text-[12px] [overflow-wrap:anywhere]">
          {/* Retour à la ligne de préférence après un « / », au milieu d'un segment seulement s'il est trop long. */}
          {redirectUri.split(/(?<=\/)/).map((part, i) => (
            <Fragment key={i}>
              {part}
              <wbr />
            </Fragment>
          ))}
        </code>
        <button type="button" className="btn btn-sm shrink-0" onClick={copy}>
          {copied ? k.copied : k.copy}
        </button>
      </div>
      <label className="block text-[12px] font-medium" htmlFor={`${id}-client`}>
        {k.clientId}
      </label>
      <input id={`${id}-client`} className="input input-sm mono !w-full" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
      <label className="block text-[12px] font-medium" htmlFor={`${id}-secret`}>
        {k.clientSecret}
      </label>
      <input id={`${id}-secret`} className="input input-sm mono !w-full" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={hasClient ? "••••••••" : ""} autoComplete="off" />
      {hasClient && <p className="text-[11px] text-trace">{k.secretKeep}</p>}
      <button type="button" className="btn btn-primary btn-sm" onClick={saveClient} disabled={busy !== null || !clientId.trim()}>
        {busy === "oauth" ? k.redirecting : k.saveConnect}
      </button>
      {entry?.token_ok && (
        <>
          <label className="block pt-1 text-[12px] font-medium" htmlFor={`${id}-token`}>
            {k.tokenAlt}
          </label>
          <div className="flex gap-2">
            <input id={`${id}-token`} className="input input-sm mono !w-full" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            <button type="button" className="btn btn-sm" onClick={saveToken} disabled={busy !== null || !token.trim()}>
              {busy === "token" ? k.testing : k.tokenSave}
            </button>
          </div>
        </>
      )}
      {err && <ErrorText>{err}</ErrorText>}
    </div>
  )
}

function CustomServer({ onAdded }: { onAdded: (c: McpConnectorPublic) => void }) {
  const { t } = useT()
  const k = t.connectors.mcp
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function add() {
    setBusy(true)
    setErr(null)
    try {
      onAdded(await api<McpConnectorPublic>("/api/connectors/mcp", { method: "POST", json: { name, url, token: token || undefined } }))
      setName("")
      setUrl("")
      setToken("")
    } catch (e) {
      setErr(fmt(k.failed, { error: errorMessage(e) }))
    }
    setBusy(false)
  }

  return (
    <details className="panel p-4">
      <summary className="cursor-pointer text-[14px] font-medium">{k.customTitle}</summary>
      <div className="mt-3 space-y-2">
        <p className="text-[12px] text-trace">{k.customLead}</p>
        <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
          <input className="input input-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={k.customName} aria-label={k.customName} autoComplete="off" />
          <input className="input input-sm mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" aria-label={k.customUrl} autoComplete="off" />
        </div>
        <input className="input input-sm mono !w-full" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={k.customToken} aria-label={k.customToken} autoComplete="off" />
        {err && <ErrorText>{err}</ErrorText>}
        <button type="button" className="btn btn-primary btn-sm" onClick={add} disabled={busy || !url.trim()}>
          {busy ? t.common.saving : k.customAdd}
        </button>
      </div>
    </details>
  )
}
