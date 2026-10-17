-- Qualité du cerveau :
-- - superseded_by : une connaissance plus récente sur le même sujet a remplacé celle-ci (elle reste lisible par son
--   auteur et dans l'historique, mais n'est plus proposée par la recherche ni les listes) ;
-- - embedding : vecteur sémantique optionnel (Voyage AI ou point de terminaison compatible OpenAI, voir
--   apps/web/lib/embeddings.ts), stocké en tableau de réels pour ne pas dépendre de l'extension pgvector.

alter table knowledge_items add column if not exists superseded_by uuid references knowledge_items(id) on delete set null;
alter table knowledge_items add column if not exists embedding real[];
alter table knowledge_items add column if not exists embedding_model text;
create index if not exists knowledge_items_superseded_idx on knowledge_items (org_id, zone) where superseded_by is null;
