-- Cerveau d'entreprise — schéma initial.
-- Compatible Supabase et Postgres « nu » (les parties propres à Supabase sont dans la migration RLS suivante).

create extension if not exists pgcrypto;

create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  -- Lien optionnel vers auth.users (Supabase Auth) pour un accès direct au cerveau via RLS.
  auth_user_id uuid unique,
  name text not null,
  email text,
  title text,
  role text not null default 'member' check (role in ('admin', 'member')),
  -- SHA-256 du jeton personnel (utilisé par brain-sync, le MCP et les hooks). Le jeton clair n'est jamais stocké.
  token_hash text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists zones (
  org_id uuid not null references orgs(id) on delete cascade,
  id text not null,
  name text not null,
  description text not null default '',
  color text not null default '#22d3ee',
  keywords text[] not null default '{}',
  position int not null default 0,
  created_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table if not exists zone_access (
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  zone_id text not null,
  can_write boolean not null default true,
  primary key (user_id, zone_id),
  foreign key (org_id, zone_id) references zones(org_id, id) on delete cascade
);

create table if not exists knowledge_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  author_id uuid not null references profiles(id) on delete cascade,
  zone text not null,
  kind text not null check (kind in ('fact', 'decision', 'task', 'procedure', 'question')),
  title text not null,
  body text not null default '',
  entities jsonb not null default '[]',
  source jsonb not null default '{}',
  confidence real not null default 0.6,
  -- Texte normalisé (minuscules, sans accents) calculé par l'API, pour une recherche insensible aux accents.
  search_title text not null default '',
  search_body text not null default '',
  search tsvector generated always as (
    setweight(to_tsvector('simple', search_title), 'A') || setweight(to_tsvector('simple', search_body), 'B')
  ) stored,
  created_at timestamptz not null default now()
);
create index if not exists knowledge_items_zone_idx on knowledge_items (org_id, zone, created_at desc);
create index if not exists knowledge_items_author_idx on knowledge_items (author_id, created_at desc);
create index if not exists knowledge_items_search_idx on knowledge_items using gin (search);

-- Graphe de connaissance : entités et liens (item ↔ entité).
create table if not exists entities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  type text not null check (type in ('person', 'project', 'client', 'tool', 'doc')),
  name text not null,
  norm_name text not null,
  created_at timestamptz not null default now(),
  unique (org_id, type, norm_name)
);

create table if not exists edges (
  id bigint generated always as identity primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  item_id uuid not null references knowledge_items(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  rel text not null default 'mentions',
  unique (item_id, entity_id, rel)
);
create index if not exists edges_entity_idx on edges (entity_id);

create table if not exists agent_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  agent text not null,
  type text not null check (type in ('started', 'query', 'write', 'stopped')),
  zones text[] not null default '{}',
  summary text,
  -- Empreinte du prompt normalisé (détection d'automatisations sans stocker le prompt brut).
  fingerprint text,
  session_id text,
  at timestamptz not null default now()
);
create index if not exists agent_events_org_id_idx on agent_events (org_id, id);
create index if not exists agent_events_at_idx on agent_events (org_id, at desc);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  title text not null,
  zone text not null,
  assignee_id uuid references profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'done')),
  source_item_id uuid references knowledge_items(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tasks_zone_idx on tasks (org_id, zone);

create table if not exists automation_suggestions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  key text not null,
  user_id uuid references profiles(id) on delete cascade,
  zone text,
  title text not null,
  description text not null,
  schedule text,
  evidence jsonb not null default '{}',
  minutes_saved_per_week int not null default 0,
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'dismissed')),
  source text not null default 'heuristic' check (source in ('heuristic', 'screenpipe')),
  created_at timestamptz not null default now(),
  unique (org_id, key)
);

create table if not exists company_status (
  org_id uuid primary key references orgs(id) on delete cascade,
  content jsonb not null,
  generated_at timestamptz not null default now()
);
