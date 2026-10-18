import { DocumentsView } from "@/components/DocumentsPanel"
import { listDocumentsFor } from "@/lib/documents"
import { requirePageViewer } from "@/lib/session"
import { runInOrg } from "@/lib/store"

export const dynamic = "force-dynamic"

/** The documents of the readable zones (and the viewer's own), most recent first. */
export default async function Page() {
  const viewer = await requirePageViewer()
  const documents = await runInOrg(viewer.real.org_id, () => listDocumentsFor(viewer))
  return <DocumentsView initial={documents} />
}
