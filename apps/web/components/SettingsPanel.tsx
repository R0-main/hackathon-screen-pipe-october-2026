"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import type { ClaudeKeyInfo } from "@/lib/claude-key"
import type { SearchSettingsPatch } from "@/lib/search-settings"
import type { SettingsOverview } from "@/lib/settings"
import { fmt } from "@/lib/i18n"
import { PageScroll } from "./AppShell"
import { ClaudeKeySetup } from "./ClaudeKey"
import { api, errorMessage } from "./format"
import { useT } from "./I18n"
import { RelTime } from "./RelTime"
import { ErrorText } from "./ui"

const TABS = ["search", "agents", "claude", "usage"] as const
type Tab = (typeof TABS)[number]

/** Measured by npm run eval (scripts/eval-data/README.md): 155 questions, with the agents' two rephrasings. */
const MEASURED = { words: ["76%", "92%"], semantic: ["85%", "96%"], rerank: ["95%", "99%"] } as const
const RESULT_CHOICES = [5, 8, 10, 12, 15, 20]
const DOCUMENT_CHOICES = [0, 1, 2, 3, 5]

/** Settings (Configuration): admins change them, members read them; on the public demo nobody changes them. */
export function SettingsPanel() {
  const { t } = useT()
  const s = t.settings
  const [tab, setTab] = useState<Tab>("search")
  const [data, setData] = useState<SettingsOverview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState<"saving" | "saved" | null>(null)
  const [busy, setBusy] = useState<"index" | "keywords" | null>(null)

  // The tab follows the address (?tab=claude from the status page), without a new history entry.
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get("tab")
    if (asked && (TABS as readonly string[]).includes(asked)) setTab(asked as Tab)
  }, [])
  const choose = (next: Tab) => {
    setTab(next)
    const params = new URLSearchParams(window.location.search)
    params.set("tab", next)
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`)
  }

  const load = useCallback(async () => {
    try {
      setData(await api<SettingsOverview>("/api/settings"))
      setErr(null)
    } catch (e) {
      setErr(fmt(s.loadError, { error: errorMessage(e) }))
    }
  }, [s])
  useEffect(() => {
    load()
  }, [load])

  async function save(patch: SearchSettingsPatch) {
    setSaving("saving")
    setErr(null)
    try {
      setData(await api<SettingsOverview>("/api/settings", { method: "PUT", json: patch }))
      setSaving("saved")
    } catch (e) {
      setSaving(null)
      setErr(fmt(s.saveError, { error: errorMessage(e) }))
    }
  }

  async function catchUp(what: "index" | "keywords") {
    setBusy(what)
    setErr(null)
    try {
      setData(await api<SettingsOverview>("/api/settings/catch-up", { method: "POST", json: { what } }))
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const edit = data?.can_edit ?? false
  const settings = data?.settings

  return (
    <PageScroll width="max-w-[860px]">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[22px] font-medium leading-tight">{s.title}</h1>
          <p className="mt-1 max-w-[62ch] text-[13px] text-trace">{s.lead}</p>
        </div>
        <p className="text-[12px] text-trace" role="status" aria-live="polite">
          {saving === "saving" ? s.saving : saving === "saved" ? s.saved : settings?.updated_by ? fmt(s.updatedBy, { name: settings.updated_by }) : ""}
          {saving === null && settings?.updated_at && (
            <>
              , <RelTime iso={settings.updated_at} />
            </>
          )}
        </p>
      </header>

      {data && !edit && <p className="inset mt-4 px-3 py-2 text-[13px]">{data.demo ? s.demoNote : s.memberNote}</p>}

      <div className="scroll-thin -mx-4 mt-5 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0" role="tablist" aria-label={s.tabsLabel}>
        <div className="flex w-max gap-1">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`settings-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`settings-panel-${id}`}
              onClick={() => choose(id)}
              className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors duration-150 ease-out ${tab === id ? "border-ink font-medium" : "border-transparent text-trace hover:text-ink"}`}
            >
              {s.tabs[id]}
            </button>
          ))}
        </div>
      </div>

      {err && <ErrorText className="mt-4">{err}</ErrorText>}

      {!data || !settings ? (
        !err && <p className="mt-6 text-[13px] text-trace">…</p>
      ) : (
        <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} className="mt-6 space-y-6">
          {tab === "search" && (
            <>
              <Section title={s.level} lead={s.levelLead}>
                <Row
                  label={s.levelWords}
                  hint={s.levelWordsHint}
                  aside={<Measured first={MEASURED.words[0]} top3={MEASURED.words[1]} />}
                  control={<Switch on disabled label={s.levelWords} />}
                />
                <Row
                  label={`+ ${s.levelSemantic}`}
                  hint={data.deployment.embeddings ? s.levelSemanticHint : s.unavailableSemantic}
                  aside={<Measured first={MEASURED.semantic[0]} top3={MEASURED.semantic[1]} />}
                  control={
                    <Switch
                      on={!!data.deployment.embeddings && settings.semantic}
                      disabled={!edit || !data.deployment.embeddings}
                      label={s.levelSemantic}
                      onChange={(on) => save({ semantic: on })}
                    />
                  }
                />
                <Row
                  label={`+ ${s.levelRerank}`}
                  hint={data.deployment.reranker ? s.levelRerankHint : s.unavailableRerank}
                  aside={<Measured first={MEASURED.rerank[0]} top3={MEASURED.rerank[1]} />}
                  control={
                    <Switch
                      on={!!data.deployment.reranker && settings.rerank}
                      disabled={!edit || !data.deployment.reranker}
                      label={s.levelRerank}
                      onChange={(on) => save({ rerank: on })}
                    />
                  }
                />
              </Section>

              {data.deployment.embeddings && (
                <Section title={s.semantic} lead={s.semanticLead}>
                  <Fact label={s.provider}>{data.deployment.embeddings.provider}</Fact>
                  <Fact label={s.model}>
                    <span className="font-mono">{data.deployment.embeddings.model}</span>
                  </Fact>
                  {data.index && (
                    <Fact label={s.index}>
                      {data.index.missing === 0 ? (
                        fmt(s.indexAll, { model: data.index.model })
                      ) : (
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <span className="tabular-nums">{fmt(s.indexState, { done: data.index.total - data.index.missing, total: data.index.total, model: data.index.model })}</span>
                          {edit && settings.semantic && (
                            <button type="button" className="btn btn-sm" onClick={() => catchUp("index")} disabled={busy !== null}>
                              {busy === "index" ? s.indexing : fmt(s.indexRest, { n: data.index.missing })}
                            </button>
                          )}
                        </span>
                      )}
                    </Fact>
                  )}
                </Section>
              )}

              {data.deployment.reranker && (
                <Section title={s.rerank} lead={s.rerankLead}>
                  <Fact label={s.model}>
                    <span className="font-mono">{data.deployment.reranker.model}</span>
                  </Fact>
                </Section>
              )}

              <Section title={s.keywords} lead={s.keywordsLead}>
                <p className="text-[13px]">{s.keywordsBy}</p>
                <Row
                  label={s.serverKeywords}
                  hint={data.claude.source ? undefined : s.catchUpNeedsClaude}
                  control={<Switch on={settings.serverKeywords} disabled={!edit} label={s.serverKeywords} onChange={(on) => save({ serverKeywords: on })} />}
                />
                <Fact label={t.knowledge.title}>
                  {data.keywords.missing === 0 ? (
                    s.keywordsAll
                  ) : (
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="tabular-nums">{fmt(s.keywordsBacklog, { n: data.keywords.missing, total: data.keywords.total })}</span>
                      {edit && data.claude.source && (
                        <button type="button" className="btn btn-sm" onClick={() => catchUp("keywords")} disabled={busy !== null}>
                          {busy === "keywords" ? s.catchingUp : s.catchUp}
                        </button>
                      )}
                    </span>
                  )}
                </Fact>
              </Section>
            </>
          )}

          {tab === "agents" && (
            <Section title={s.tabs.agents} lead={s.agentsLead}>
              <Row
                label={s.results}
                hint={s.resultsHint}
                control={
                  <Choices
                    label={s.results}
                    value={settings.agents.limit}
                    options={RESULT_CHOICES.map((n) => ({ value: n, label: String(n) }))}
                    disabled={!edit}
                    onChange={(limit) => save({ agents: { limit } })}
                  />
                }
              />
              <Row
                label={s.format}
                hint={`${settings.agents.detail === "compact" ? s.compactHint : s.fullHint} ${s.agentOverride}`}
                control={
                  <Choices
                    label={s.format}
                    value={settings.agents.detail}
                    options={[
                      { value: "compact", label: s.compact },
                      { value: "full", label: s.full },
                    ]}
                    disabled={!edit}
                    onChange={(detail) => save({ agents: { detail } })}
                  />
                }
              />
              <Row
                label={s.documents}
                hint={s.documentsHint}
                control={
                  <Choices
                    label={s.documents}
                    value={settings.agents.documents}
                    options={DOCUMENT_CHOICES.map((n) => ({ value: n, label: String(n) }))}
                    disabled={!edit}
                    onChange={(documents) => save({ agents: { documents } })}
                  />
                }
              />
              <Fact label={s.perSearch}>
                {data.tokens.sample === 0 ? (
                  <span className="text-trace">{s.estimateNone}</span>
                ) : (
                  <span>
                    <span className="font-medium tabular-nums">{fmt(s.perSearchValue, { n: tokens(settings.agents.detail === "full" ? data.tokens.full : data.tokens.compact) })}</span>
                    <span className="text-trace">
                      {" · "}
                      {fmt(s.perSearchOther, {
                        n: tokens(settings.agents.detail === "full" ? data.tokens.compact : data.tokens.full),
                        format: settings.agents.detail === "full" ? s.compact : s.full,
                      })}
                    </span>
                    <span className="mt-1 block text-[12px] text-trace">{fmt(s.estimateNote, { n: data.tokens.sample })}</span>
                  </span>
                )}
              </Fact>
            </Section>
          )}

          {tab === "claude" && (
            <Section title={s.tabs.claude} lead={s.claudeLead}>
              <ClaudeKeySetup info={data.claude} onInfo={(claude: ClaudeKeyInfo) => {
                  setData({ ...data, claude })
                  load()
                }} readOnly={!edit} />
              <Fact label={s.usedFor}>{s.usedForText}</Fact>
              <Fact label={s.withoutKey}>{s.withoutKeyText}</Fact>
            </Section>
          )}

          {tab === "usage" && (
            <>
              <Section title={s.thisMonth}>
                <Fact label={s.agentSearches}>
                  <span className="tabular-nums">{data.usage.agent_searches.toLocaleString("en-US")}</span>
                </Fact>
                <Fact label={s.knowledgeItems}>
                  <span className="tabular-nums">{data.keywords.total.toLocaleString("en-US")}</span>
                </Fact>
                {data.index && settings.semantic && (
                  <Fact label={s.indexed}>
                    <span className="tabular-nums">
                      {(data.index.total - data.index.missing).toLocaleString("en-US")} / {data.index.total.toLocaleString("en-US")}
                    </span>
                  </Fact>
                )}
              </Section>
              <Section title={s.leaves} lead={s.leavesLead}>
                {data.leaves.length === 0 ? (
                  <p className="text-[13px]">{s.leavesNone}</p>
                ) : (
                  <ul className="list-disc space-y-1.5 pl-5 text-[13px]">
                    {data.leaves.map((l) => (
                      <li key={l.who}>{fmt(s.receives, { who: l.who, what: l.what })}</li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          )}
        </div>
      )}
    </PageScroll>
  )
}

/** "1,370": a rounded figure, the estimate is not precise to the token. */
function tokens(n: number): string {
  return (n < 1000 ? Math.round(n / 10) * 10 : Math.round(n / 50) * 50).toLocaleString("en-US")
}

function Section({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="panel-title">{title}</h2>
        {lead && <p className="max-w-[68ch] text-[13px] text-trace">{lead}</p>}
      </div>
      {children}
    </section>
  )
}

/** A setting: its name and what it does on the left, the control on the right (below on a phone). */
function Row({ label, hint, aside, control }: { label: string; hint?: string; aside?: ReactNode; control: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-t border-line pt-3">
      <div className="min-w-0 max-w-[52ch] flex-1">
        <p className="text-[13.5px] font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-[12.5px] text-trace">{hint}</p>}
      </div>
      <div className="flex items-center gap-4">
        {aside}
        {control}
      </div>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[11rem_minmax(0,1fr)]">
      <p className="text-trace">{label}</p>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function Measured({ first, top3 }: { first: string; top3: string }) {
  const { t } = useT()
  return <span className="whitespace-nowrap text-[12px] tabular-nums text-trace">{fmt(t.settings.measured, { first, top3 })}</span>
}

function Switch({ on, disabled = false, label, onChange }: { on: boolean; disabled?: boolean; label: string; onChange?: (on: boolean) => void }) {
  const { t } = useT()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={on ? t.settings.on : t.settings.off}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full border transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-60 ${
        on ? "border-ink bg-ink" : "border-line-strong bg-surface"
      }`}
    >
      <span
        aria-hidden
        className={`absolute top-[2px] size-4 rounded-full transition-transform duration-150 ease-out ${on ? "translate-x-[18px] bg-bone" : "translate-x-[2px] bg-line-strong"}`}
      />
    </button>
  )
}

function Choices<T extends string | number>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  disabled: boolean
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          onClick={() => o.value !== value && onChange(o.value)}
          className={`chip tabular-nums disabled:cursor-not-allowed ${o.value === value ? "chip-on" : ""} ${disabled && o.value !== value ? "opacity-60" : ""}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
