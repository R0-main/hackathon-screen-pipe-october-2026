-- Désinstallation d'un poste (`brain uninstall` → POST /api/uninstall) : la date est notée sur le profil et le jeton est
-- révoqué. Un nouveau prompt (jeton régénéré par un admin) efface la date : le poste peut être rebranché.

alter table profiles add column if not exists uninstalled_at timestamptz;
