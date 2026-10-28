import { SearchSettingsPatchSchema, setSearchSettings } from "@/lib/search-settings"
import { settingsOverview } from "@/lib/settings"
import { getStore } from "@/lib/store"
import { DEMO_SETTINGS_READ_ONLY } from "@/lib/demo-mode"
import { json, parseBody, withViewer } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The Settings page: the company's search settings and what they imply. Members read them, admins change them. */
export const GET = withViewer(async (_req, viewer) => json(await settingsOverview(viewer)))

/** Admins: changes some search settings (the rest stays), then sends the page's data back. */
export const PUT = withViewer(
  async (req, viewer) => {
    const body = await parseBody(req, SearchSettingsPatchSchema)
    if ("response" in body) return body.response
    await setSearchSettings(getStore(), body.data, viewer.real.name)
    return json(await settingsOverview(viewer))
  },
  { admin: true, demoReadOnly: DEMO_SETTINGS_READ_ONLY },
)
