-- Brain quality:
-- - superseded_by: a more recent knowledge item on the same subject replaced this one (it stays readable by its
--   author and in the history, but is no longer offered by search or the lists);
-- - embedding: optional semantic vector (Voyage AI or an OpenAI-compatible endpoint, see
--   apps/web/lib/embeddings.ts), stored as an array of reals so as not to depend on the pgvector extension.

alter table knowledge_items add column if not exists superseded_by uuid references knowledge_items(id) on delete set null;
alter table knowledge_items add column if not exists embedding real[];
alter table knowledge_items add column if not exists embedding_model text;
create index if not exists knowledge_items_superseded_idx on knowledge_items (org_id, zone) where superseded_by is null;
