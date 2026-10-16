-- Réglages internes du cerveau : secret de signature des sessions du dashboard (généré une seule fois par l'API).
-- Lu et écrit uniquement par l'API (rôle propriétaire). RLS activée SANS aucune politique : aucun accès direct
-- (clé anon, utilisateurs Supabase Auth), même en lecture.

create table if not exists brain_settings (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);

alter table brain_settings enable row level security;
revoke all on brain_settings from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on brain_settings from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on brain_settings from authenticated;
  end if;
end $$;
