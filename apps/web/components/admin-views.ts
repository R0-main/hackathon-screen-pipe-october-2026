/** The "Team and access" views: one page each, as a sidebar sub-menu. */
export type AdminTab = "org" | "access" | "requests" | "zones"

export const ADMIN_VIEWS: { id: AdminTab; slug: string; href: string; label: string; lead: string }[] = [
  { id: "org", slug: "", href: "/admin", label: "Org chart", lead: "Who reports to whom, and the connected workstations." },
  { id: "access", slug: "access", href: "/admin/access", label: "Zone access", lead: "Who reads which zone of the brain." },
  { id: "requests", slug: "requests", href: "/admin/requests", label: "Requests", lead: "The team message and the requests to accept." },
  { id: "zones", slug: "zones", href: "/admin/zones", label: "Zones", lead: "The parts of the brain and their keywords." },
]
