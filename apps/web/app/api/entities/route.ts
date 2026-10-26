import { AGENTS, ENTITY_TYPES, type AgentName, type EntityType } from "@brain/core"
import { exploreEntity } from "@/lib/brain"
import { error, json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * An entity's place in the knowledge graph (MCP explore_entity): `?name=` (and `type=` when a name has several), in
 * the zones the token reads. `agent=mcp`: read by an agent, its zones light up.
 */
export const GET = withViewer(async (req, viewer) => {
  const url = new URL(req.url)
  const name = (url.searchParams.get("name") ?? "").trim()
  const type = url.searchParams.get("type") || undefined
  const agent = url.searchParams.get("agent") || undefined
  if (!name || name.length > 200) return error(400, "Give the entity's name (?name=, 200 characters at most).")
  if (type && !(ENTITY_TYPES as readonly string[]).includes(type)) return error(400, `Unknown entity type "${type}": ${ENTITY_TYPES.join(", ")}.`)
  return json(
    await exploreEntity(viewer, {
      name,
      type: type as EntityType | undefined,
      agent: agent && (AGENTS as readonly string[]).includes(agent) ? (agent as AgentName) : undefined,
    }),
  )
})
