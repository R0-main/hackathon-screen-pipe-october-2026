import { importMcp } from "@/lib/remote-mcp"
import { json, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/connectors/mcp/:id/import — importe maintenant le contenu du connecteur dans le cerveau (Claude l'explore en
 * lecture seule). Renvoie le compte rendu de l'import, réussi ou non. Admins.
 */
export const POST = withViewer<Ctx>(
  async (_req, viewer, { params }) => {
    const { id } = await params
    return json(await importMcp(viewer, id))
  },
  { admin: true },
)
