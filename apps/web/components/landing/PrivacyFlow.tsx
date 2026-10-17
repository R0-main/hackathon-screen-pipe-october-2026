import { Dot, zoneColor } from "../ui"
import { LANDING_ZONES } from "./landing-data"

/*
  « Le brut reste sur le poste », montré avec de vraies captures de la démo Fournil : ce que Screenpipe enregistre
  sur le poste, les trois étapes du filtre local, et les quelques connaissances qui montent au cerveau.

  Le balisage décrit l'état final (lisible sans JavaScript et sous prefers-reduced-motion) : captures perso
  écartées, secret masqué, connaissances arrivées. La version Récit le rejoue au scroll (motion/setup.ts,
  attributs data-pf-*).
*/

type Capture = { app: string; text: string; kind: "work" | "personal" | "secret" }

const CAPTURES: Capture[] = [
  { app: "Claude Code", text: "Comment on déploie Fournil en production ?", kind: "work" },
  { app: "WhatsApp", text: "Photos du week-end", kind: "personal" },
  { app: "Terminal", text: "export STRIPE_KEY=", kind: "secret" },
  { app: "Codex", text: "Rapproche les relevés Qonto d'hier", kind: "work" },
  { app: "Banque perso", text: "Relevé de compte d'octobre", kind: "personal" },
  { app: "Slack", text: "#dev : la file SMS passe en prod", kind: "work" },
]

const STEPS = ["Apps de travail seulement", "Secrets masqués", "Distillé sur le poste"]

const KNOWLEDGE = [
  { zone: "dev", kind: "Procédure", title: "Déployer Fournil en production" },
  { zone: "compta", kind: "Procédure", title: "Rapprocher Qonto et Pennylane chaque matin" },
  { zone: "dev", kind: "Décision", title: "Les SMS de précommande passent par une file" },
]

const zone = (id: string) => LANDING_ZONES.find((z) => z.id === id)!

export function PrivacyFlow() {
  return (
    <figure data-privacy className="privacy-flow" aria-label="Sur le poste, Screenpipe enregistre tout ; le filtre local écarte le perso, masque les secrets et distille ; seules trois connaissances montent au cerveau.">
      {/* Le poste : tout ce que Screenpipe capte, qui ne part jamais. */}
      <div data-pf-poste className="panel overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <span className="panel-title block">Le poste de Hugo</span>
          <span data-pf-weight className="mt-0.5 block text-[12px] tabular-nums text-trace">19 Go en deux semaines</span>
        </div>
        <ul className="divide-y divide-line">
          {CAPTURES.map((c) => (
            <li key={c.app} data-pf-row data-kind={c.kind} className="privacy-row relative px-4 py-2">
              <span data-pf-dim={c.kind === "personal" ? "" : undefined} className="flex items-center justify-between gap-3 text-[12px] font-medium">
                {c.app}
                {c.kind === "work" && (
                  <span data-pf-pass className="inline-flex shrink-0 items-center gap-1 text-[11px] font-normal text-trace">
                    <span className="size-[6px] rounded-full bg-ink" aria-hidden />
                    retenu
                  </span>
                )}
              </span>
              <span data-pf-dim={c.kind === "personal" ? "" : undefined} className="mt-0.5 block text-[12px] leading-snug text-trace">
                {c.kind === "secret" ? (
                  <span className="mono">
                    {c.text}
                    <span className="relative inline-block whitespace-nowrap">
                      <span className="text-ink">sk_live_51Hf8Q</span>
                      <span data-pf-mask className="privacy-mask" aria-hidden />
                      <span className="sr-only">(secret masqué)</span>
                    </span>
                  </span>
                ) : (
                  c.text
                )}
              </span>
              {c.kind === "personal" && <span data-pf-strike className="privacy-strike" aria-hidden />}
            </li>
          ))}
        </ul>
        <p className="border-t border-line px-4 py-2.5 text-[12px] text-trace">et 18 400 autres captures, qui restent ici</p>
      </div>

      {/* Le filtre local : un rail de trois étapes, sur le poste. */}
      <ol data-pf-filter className="privacy-rail" aria-label="Filtre local">
        <span data-pf-rail className="privacy-rail-line" aria-hidden />
        {STEPS.map((s) => (
          <li key={s} data-pf-step className="relative flex items-start gap-2.5">
            <span className="privacy-node" aria-hidden>
              <span data-pf-node />
            </span>
            <span className="text-[12px] leading-snug">{s}</span>
          </li>
        ))}
      </ol>

      {/* Le cerveau : ce qui monte, et rien d'autre. */}
      <div data-pf-brain className="panel overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <span className="panel-title block">Le cerveau</span>
          <span data-pf-weight className="mt-0.5 block text-[12px] tabular-nums text-trace">quelques Ko</span>
        </div>
        <ul className="divide-y divide-line">
          {KNOWLEDGE.map((k) => (
            <li key={k.title} data-pf-chip className="px-4 py-2.5">
              <span className="flex items-center justify-between gap-3 text-[12px] text-trace">
                <span className="inline-flex items-center gap-1.5">
                  <Dot color={zoneColor(zone(k.zone).color, zone(k.zone).position)} />
                  {zone(k.zone).name}
                </span>
                <span>{k.kind}</span>
              </span>
              <span className="mt-0.5 block text-[13px] leading-snug">{k.title}</span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  )
}
