/** Les vues d'« Équipe et accès » : une page chacune, en sous-menu de la barre latérale. */
export type AdminTab = "org" | "access" | "requests" | "zones"

export const ADMIN_VIEWS: { id: AdminTab; slug: string; href: string; label: string; lead: string }[] = [
  { id: "org", slug: "", href: "/admin", label: "Organigramme", lead: "Qui est rattaché à qui, et les postes branchés." },
  { id: "access", slug: "acces", href: "/admin/acces", label: "Accès par zone", lead: "Qui lit quelle zone du cerveau." },
  { id: "requests", slug: "demandes", href: "/admin/demandes", label: "Demandes", lead: "Le message d'équipe et les demandes à accepter." },
  { id: "zones", slug: "zones", href: "/admin/zones", label: "Zones", lead: "Les parties du cerveau et leurs mots-clés." },
]
