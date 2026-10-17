-- Tâches importées par un connecteur (Linear, Todoist) : d'où elles viennent, leur identifiant chez l'outil (pour les
-- mettre à jour sans doublon) et le lien pour les ouvrir. Les tâches extraites des sessions IA gardent ces colonnes nulles.

alter table tasks add column if not exists external_source text;
alter table tasks add column if not exists external_id text;
alter table tasks add column if not exists external_url text;
create unique index if not exists tasks_external_idx on tasks (org_id, external_source, external_id) where external_id is not null;
