// show_team: the dashboard's org chart. A click on a card shows the person's zones; their page opens in the browser.

import { useState } from "react"
import { OrgChart } from "@/components/OrgChart"
import { Dot, zoneColor } from "@/components/ui"
import { openBrainPage } from "./links"
import type { TeamPayload } from "./types"

const INLINE_H = 520

export function TeamApp({ data, fullscreen }: { data: TeamPayload; fullscreen: boolean }) {
  const [selected, setSelected] = useState<string | null>(null)
  const person = data.users.find((u) => u.id === selected) ?? null
  const manager = person?.manager_id ? data.users.find((u) => u.id === person.manager_id) : null
  const reports = person ? data.users.filter((u) => u.manager_id === person.id) : []

  return (
    <div className="relative w-full overflow-hidden" style={{ height: fullscreen ? "100%" : INLINE_H }}>
      <OrgChart users={data.users} zones={data.zones} presence={data.presence} selected={selected} onSelect={setSelected} showZones={data.with_zones} />
      {person && (
        <aside className="panel absolute right-3 top-3 w-[min(300px,calc(100%-1.5rem))] p-4" aria-label={person.name}>
          <h2 className="text-[14px] font-medium leading-tight">{person.name}</h2>
          <p className="mt-0.5 text-[12.5px] text-trace">{person.title || (person.role === "admin" ? "Admin" : "Member")}</p>
          <p className="mt-2 text-[12.5px] text-trace">
            {manager ? `Reports to ${manager.name}` : "Head of the org chart"}
            {reports.length > 0 && ` · ${reports.length} direct report${reports.length > 1 ? "s" : ""}`}
          </p>
          {person.zones.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1 text-[12px]">
              {person.zones.map((id) => {
                const z = data.zones.find((x) => x.id === id)
                return z ? (
                  <span key={id} className="chip">
                    <Dot color={zoneColor(z.color, z.position)} size={7} /> {z.name}
                  </span>
                ) : null
              })}
            </div>
          )}
          <button type="button" className="btn btn-sm mt-3" onClick={() => openBrainPage(`/people/${person.id}`)}>
            Open their page
          </button>
        </aside>
      )}
    </div>
  )
}
