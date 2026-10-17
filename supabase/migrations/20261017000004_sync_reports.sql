-- Comptes rendus de synchronisation envoyés par les postes (brain sync → POST /api/sync/report) : compteurs seulement,
-- jamais de contenu. Un historique court par poste (purgé par l'API), le dernier sert à la page Supervision.
-- Lus et écrits uniquement par l'API (rôle propriétaire) : RLS activée sans politique.

create table if not exists sync_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  at timestamptz not null,
  ok boolean not null,
  duration_ms int not null default 0,
  items_sent int not null default 0,
  duplicates int not null default 0,
  conversations jsonb not null default '{}',
  distiller text not null default 'heuristic',
  failed int not null default 0,
  deferred int not null default 0,
  error text,
  client_version text,
  platform text,
  screenpipe boolean,
  created_at timestamptz not null default now()
);
create index if not exists sync_reports_user_idx on sync_reports (org_id, user_id, at desc);

alter table sync_reports enable row level security;
revoke all on sync_reports from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on sync_reports from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on sync_reports from authenticated;
  end if;
end $$;
