import { strict as assert } from "node:assert"
import { test } from "node:test"
import { formatQuery } from "../src/format"

test("search_brain : une connaissance remplacée est signalée à l'agent, avec la nouvelle", () => {
  const base = { zone: "compta", kind: "decision" as const, body: "…", entities: [], source: { app: "Claude", tool: "claude", at: "2026-10-01T09:00:00Z" }, confidence: 0.8, created_at: "2026-10-01T09:00:00Z", author_id: "a", author: "Jean-Marc" }
  const text = formatQuery(
    {
      query: "relances",
      zones_searched: ["compta"],
      zones_hit: ["compta"],
      zones_restricted: [],
      items: [
        { ...base, id: "new", title: "On passe aux relances automatiques de Pennylane" },
        { ...base, id: "old", title: "Relances à la main depuis Gmail", superseded_by: "new", superseded_by_title: "On passe aux relances automatiques de Pennylane" },
      ],
    },
    (z) => z,
  )
  assert.match(text, /### 2\. Relances à la main depuis Gmail \(remplacée\)/)
  assert.match(text, /ATTENTION : remplacée par une connaissance plus récente \(« On passe aux relances automatiques de Pennylane »\), ne t'appuie pas dessus\./)
  assert.doesNotMatch(text, /### 1\. On passe aux relances automatiques de Pennylane \(remplacée\)/)
})
