-- Search keywords (packages/core/src/keywords.ts): terms a colleague might type to find a knowledge item that its text
-- does not contain, written by a model for each item. Kept apart from the title and the body, and indexed with the
-- lowest weight (D): they bring an item into a search, they never outrank the words of its title and text.
-- - keywords: the terms as written, returned with the item;
-- - search_keywords: the same, normalized by the API (lowercase, without accents), like search_title and search_body.
-- A generated column cannot change its expression: `search` is dropped (with its index) and created again.

alter table knowledge_items add column if not exists keywords text[] not null default '{}';
alter table knowledge_items add column if not exists search_keywords text not null default '';
alter table knowledge_items drop column if exists search;
alter table knowledge_items add column search tsvector generated always as (
  setweight(to_tsvector('simple', search_title), 'A') || setweight(to_tsvector('simple', search_body), 'B')
    || setweight(to_tsvector('simple', search_keywords), 'D')
) stored;
create index if not exists knowledge_items_search_idx on knowledge_items using gin (search);
