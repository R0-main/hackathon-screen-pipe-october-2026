-- Documents: the original files (PDF, Word, Excel, PowerPoint, CSV…) that go to the brain with the distilled
-- knowledge (the revenue PDF behind "Q3 revenue: €1.24M"). Filed in a zone, a document is read with the same rights as
-- its knowledge: the zone's readers, the admins, and its author (right of review).
-- The bytes stay in the table (bytea, 3 MB at most per file, checked by the API): no storage bucket to configure.
-- The text extracted by the API (normalized in search_*) feeds the search, like knowledge_items.

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  author_id uuid not null references profiles(id) on delete cascade,
  zone text not null,
  name text not null,
  mime text not null,
  size int not null,
  sha256 text not null,
  title text not null default '',
  summary text not null default '',
  pages int,
  source jsonb not null default '{}',
  -- Knowledge items the document backs (no foreign key: a deleted item is simply ignored on read).
  item_ids uuid[] not null default '{}',
  content bytea not null,
  text text not null default '',
  search_title text not null default '',
  search_body text not null default '',
  search tsvector generated always as (
    setweight(to_tsvector('simple', search_title), 'A') || setweight(to_tsvector('simple', search_body), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  -- The same file sent again (another sync, another colleague) is the same document, linked to more knowledge.
  unique (org_id, sha256)
);
create index if not exists documents_zone_idx on documents (org_id, zone, created_at desc);
create index if not exists documents_search_idx on documents using gin (search);
create index if not exists documents_items_idx on documents using gin (item_ids);

alter table documents enable row level security;

drop policy if exists "documents by zone" on documents;
create policy "documents by zone" on documents for select
  using (org_id = brain_org_id() and (brain_can_read_zone(zone) or author_id = brain_profile_id()));

drop policy if exists "author deletes their documents" on documents;
create policy "author deletes their documents" on documents for delete
  using (org_id = brain_org_id() and (author_id = brain_profile_id() or brain_is_admin()));
