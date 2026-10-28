// The public demo company (BRAIN_DEMO=1): what visitors may not change there. A company created next to it on the same
// deployment (/create) is a real company, never concerned.

import { isDemoMode } from "./auth"
import { getRootStore, storeForOrg } from "./store"
import { DEMO_ORG } from "../scripts/demo-data"

/** Refusal of a change the demo does not allow. */
export const DEMO_CONNECTORS_READ_ONLY =
  "The demo's connectors are read-only: Encore's tools stay as they are, and agents do not call them. Create your company to connect your own tools."
export const DEMO_SETTINGS_READ_ONLY =
  "The demo's settings are read-only: every visitor sees the same Encore. Create your company to set your own search and Claude key."

/** True for the demo company itself: demo mode, the deployment's base company, still named Encore. */
export async function isDemoCompany(orgId: string): Promise<boolean> {
  if (!isDemoMode()) return false
  const [base] = await getRootStore().listOrgIds()
  if (base !== orgId) return false
  return (await storeForOrg(orgId).getOrg()).name === DEMO_ORG.name
}
