"use client"

import Link from "next/link"
import { useState } from "react"
import { CheckIcon } from "../ui"

/*
  Deux façons d'avoir son cerveau : sur ses propres serveurs (le code est ouvert) ou sur notre cloud, puis les
  tarifs. Front seulement : les prix sont indicatifs et le paiement n'est branché nulle part. Les boutons cloud
  mènent à la création d'une entreprise (ou à la démo quand la création est fermée).
*/

const REPO = "https://github.com/R0-main/hackathon-screen-pipe-october-2026"
const GUIDE = `${REPO}#déployer-le-cerveau-partagé-vercel--neon-offres-gratuites`

const COMMANDS = [
  `git clone ${REPO} nos-brainer`,
  "cd nos-brainer && npm ci && npm run build",
  "export DATABASE_URL=postgres://… BRAIN_PUBLIC_URL=https://cerveau.exemple.fr",
  "npm run db:migrate && npm start",
]

type Cta = { href: string; label: string }

function Features({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((f) => (
        <li key={f} className="flex gap-2.5 text-[14px] leading-snug">
          <CheckIcon className="mt-[1px] shrink-0" />
          <span>{f}</span>
        </li>
      ))}
    </ul>
  )
}

/** Chez vous ou chez nous : le même cerveau, deux hébergements. */
export function Hosting({ onAnchor }: { onAnchor?: (e: React.MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <section data-hold="1" className="landing-section relative border-t border-line" aria-labelledby="heberger">
      <span data-bead className="landing-bead" aria-hidden>
        <span data-bead-fill />
      </span>
      <div className="landing-wrap">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end lg:gap-20">
          <h2 id="heberger" data-reveal="title" className="landing-h2 max-w-[11em]">
            Chez vous, ou chez nous.
          </h2>
          <div data-reveal="text" className="max-w-[34em]">
            <p className="text-[16px] leading-relaxed sm:text-[17px]">
              C'est le même cerveau dans les deux cas. Le code est ouvert : installez-le sur votre infrastructure, ou laissez-nous l'héberger en Europe et ne pensez plus au serveur.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-trace">Où qu'il tourne, le brut reste sur les postes, et Claude Code ou Codex passent par l'abonnement de chacun.</p>
          </div>
        </div>

        <ul data-reveal="cards" className="mt-12 grid gap-4 lg:mt-16 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <li className="panel flex flex-col px-5 py-6 sm:px-6">
            <p className="panel-title">Sur vos serveurs</p>
            <p className="mt-1 text-[13px] text-trace">Gratuit, sans limite de postes.</p>
            <pre className="inset mono mt-4 overflow-x-auto px-3.5 py-3 text-[12px] leading-relaxed" aria-label="Installer le cerveau sur son serveur">
              {COMMANDS.join("\n")}
            </pre>
            <div className="mt-5">
              <Features items={["N'importe quel Postgres : Neon, Supabase ou le vôtre.", "Les connaissances ne quittent pas votre réseau.", "Les postes se branchent sur votre adresse."]} />
            </div>
            <a href={GUIDE} target="_blank" rel="noreferrer" className="landing-link mt-auto pt-6 text-[14px]">
              Lire le guide d'installation
            </a>
          </li>
          <li className="panel flex flex-col px-5 py-6 sm:px-6">
            <p className="panel-title">Sur notre cloud</p>
            <p className="mt-1 text-[13px] text-trace">
              À partir de 8{" "}€ par poste et par mois.
            </p>
            <div className="mt-5">
              <Features
                items={[
                  "Hébergé en Europe, à Francfort.",
                  "Sauvegardes, mises à jour et certificats gérés pour vous.",
                  "Votre cerveau est prêt en quatre questions.",
                  "Un prompt à coller par poste, rien à installer côté serveur.",
                ]}
              />
            </div>
            <a href="#tarifs" onClick={onAnchor} className="landing-link mt-auto pt-6 text-[14px]">
              Voir les tarifs
            </a>
          </li>
        </ul>
      </div>
    </section>
  )
}

type Billing = "month" | "year"

type Plan = {
  name: string
  where: string
  price: (b: Billing) => string
  unit: (b: Billing) => string
  features: string[]
  cta: Cta & { external?: boolean }
  primary?: boolean
}

/** Les offres. `cloud` : où mènent les boutons cloud (création d'entreprise ou démo). */
export function Pricing({ cloud }: { cloud: string }) {
  const [billing, setBilling] = useState<Billing>("year")
  const plans: Plan[] = [
    {
      name: "Auto-hébergé",
      where: "Sur vos serveurs",
      price: () => "0 €",
      unit: () => "pour toujours",
      features: ["Postes illimités", "Tout le cerveau : zones, agents, automatisations", "Votre Postgres, votre infrastructure", "Entraide sur GitHub"],
      cta: { href: GUIDE, label: "Lire le guide", external: true },
    },
    {
      name: "Équipe",
      where: "Sur notre cloud",
      price: (b) => (b === "year" ? "8 €" : "10 €"),
      unit: (b) => (b === "year" ? "par poste et par mois, facturé à l'année" : "par poste et par mois"),
      features: ["Jusqu'à 50 postes", "Hébergé en Europe", "Sauvegardes chaque nuit", "Support par e-mail sous un jour ouvré"],
      cta: { href: cloud, label: "Créer mon entreprise" },
      primary: true,
    },
    {
      name: "Entreprise",
      where: "Sur notre cloud ou chez vous",
      price: () => "Sur devis",
      unit: () => "à partir de 50 postes",
      features: ["Postes illimités", "SSO et journal des accès", "Région et durée de conservation au choix", "Accompagnement au déploiement et à l'information du CSE"],
      cta: { href: cloud, label: "Démarrer un pilote" },
    },
  ]

  return (
    <section id="tarifs" data-hold="1" className="landing-section relative border-t border-line" aria-labelledby="tarifs-titre">
      <span data-bead className="landing-bead" aria-hidden>
        <span data-bead-fill />
      </span>
      <div className="landing-wrap">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="tarifs-titre" data-reveal="title" className="landing-h2 max-w-[12em]">
              Un prix par poste, sans surprise.
            </h2>
            <p data-reveal="text" className="mt-5 max-w-[32em] text-[16px] leading-relaxed sm:text-[17px]">
              Vous ne payez que les postes branchés au cerveau. Les connaissances, les zones et les agents ne sont pas comptés.
            </p>
          </div>
          <div data-reveal="text" className="inline-flex self-start rounded-[6px] border border-line-strong bg-surface p-0.5 lg:self-auto" role="group" aria-label="Facturation">
            {(
              [
                ["month", "Mensuel"],
                ["year", "Annuel, −20 %"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={billing === value}
                onClick={() => setBilling(value)}
                className={`h-8 rounded-[4px] px-3 text-[13px] font-medium transition-colors duration-150 ease-out ${billing === value ? "bg-ink text-surface" : "text-trace hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <ul data-reveal="cards" className="mt-12 grid gap-4 lg:mt-16 lg:grid-cols-3">
          {plans.map((p) => (
            <li key={p.name} className={`panel flex flex-col px-5 py-6 sm:px-6 ${p.primary ? "!border-ink" : ""}`}>
              <div className="flex items-center justify-between gap-3">
                <p className="panel-title">{p.name}</p>
                {p.primary && <span className="chip">Le plus simple</span>}
              </div>
              <p className="mt-1 text-[13px] text-trace">{p.where}</p>
              <p className="mt-6 text-[40px] font-medium leading-none tracking-[-0.03em] tabular-nums" aria-live="polite">
                {p.price(billing)}
              </p>
              <p className="mt-2 min-h-[2.6em] text-[13px] leading-snug text-trace">{p.unit(billing)}</p>
              <div className="mt-5 border-t border-line pt-5">
                <Features items={p.features} />
              </div>
              <div className="mt-auto pt-8">
                {p.cta.external ? (
                  <a href={p.cta.href} target="_blank" rel="noreferrer" className="btn btn-lg w-full">
                    {p.cta.label}
                  </a>
                ) : (
                  <Link href={p.cta.href} className={`btn btn-lg w-full ${p.primary ? "btn-primary" : ""}`}>
                    {p.cta.label}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>

        <p data-reveal="text" className="mt-6 text-[13px] text-trace">
          Tarifs indicatifs, hors taxes. Le paiement n'est pas encore ouvert.
        </p>
      </div>
    </section>
  )
}
