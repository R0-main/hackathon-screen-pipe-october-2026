-- Internal settings of the brain: signing secret of the dashboard sessions (generated only once by the API).
-- Read and written only by the API (owner role). RLS enabled WITHOUT any policy: no direct access
-- (anon key, Supabase Auth users), not even to read.

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
