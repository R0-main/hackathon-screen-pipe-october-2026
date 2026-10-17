-- Décisions remplacées : une connaissance plus récente qui contredit ou met à jour une ancienne la marque comme remplacée.
-- L'ancienne reste consultable (et passe derrière dans les recherches) ; supprimer la nouvelle la rend de nouveau d'actualité.
alter table knowledge_items add column if not exists superseded_by uuid references knowledge_items(id) on delete set null;
alter table knowledge_items add column if not exists superseded_at timestamptz;
create index if not exists knowledge_items_superseded_idx on knowledge_items (superseded_by) where superseded_by is not null;
