-- Row Level Security: a user only reads the zones they have access to, admins see everything.
--
-- The dashboard API connects with the owner role (DATABASE_URL) and applies these rules itself
-- (lib/access.ts). These policies protect DIRECT access to the database (anon key / Supabase Auth users
-- linked through profiles.auth_user_id): without a matching policy, access is denied by default.
--
-- On a Postgres without Supabase, first create a minimal "auth" schema (see supabase/local/auth_stub.sql).
-- The policy names below were renamed to English by 20261018000001_english.sql.

alter table orgs enable row level security;
alter table profiles enable row level security;
alter table zones enable row level security;
alter table zone_access enable row level security;
alter table knowledge_items enable row level security;
alter table entities enable row level security;
alter table edges enable row level security;
alter table agent_events enable row level security;
alter table tasks enable row level security;
alter table automation_suggestions enable row level security;
alter table company_status enable row level security;

create or replace function brain_profile_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from profiles where auth_user_id = auth.uid()
$$;

create or replace function brain_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from profiles where auth_user_id = auth.uid()
$$;

create or replace function brain_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from profiles where auth_user_id = auth.uid()), false)
$$;

create or replace function brain_can_read_zone(z text) returns boolean
language sql stable security definer set search_path = public as $$
  select brain_is_admin() or exists (
    select 1 from zone_access za where za.user_id = brain_profile_id() and za.zone_id = z
  )
$$;

drop policy if exists "membres : lire son org" on orgs;
create policy "membres : lire son org" on orgs for select using (id = brain_org_id());

drop policy if exists "membres : lire l'équipe" on profiles;
create policy "membres : lire l'équipe" on profiles for select using (org_id = brain_org_id());

drop policy if exists "membres : lire les zones" on zones;
create policy "membres : lire les zones" on zones for select using (org_id = brain_org_id());

drop policy if exists "membres : lire ses accès" on zone_access;
create policy "membres : lire ses accès" on zone_access for select using (user_id = brain_profile_id() or brain_is_admin());

drop policy if exists "admins : gérer les accès" on zone_access;
create policy "admins : gérer les accès" on zone_access for all using (brain_is_admin()) with check (brain_is_admin());

drop policy if exists "lecture par zone" on knowledge_items;
create policy "lecture par zone" on knowledge_items for select
  using (org_id = brain_org_id() and brain_can_read_zone(zone));

drop policy if exists "l'auteur supprime ses items" on knowledge_items;
create policy "l'auteur supprime ses items" on knowledge_items for delete
  using (author_id = brain_profile_id() or brain_is_admin());

drop policy if exists "membres : lire les entités" on entities;
create policy "membres : lire les entités" on entities for select using (org_id = brain_org_id());

drop policy if exists "liens des items lisibles" on edges;
create policy "liens des items lisibles" on edges for select
  using (exists (select 1 from knowledge_items k where k.id = item_id and brain_can_read_zone(k.zone)));

drop policy if exists "événements visibles" on agent_events;
create policy "événements visibles" on agent_events for select
  using (org_id = brain_org_id() and (user_id = brain_profile_id() or brain_is_admin() or exists (
    select 1 from unnest(zones) z where brain_can_read_zone(z)
  )));

drop policy if exists "tâches par zone" on tasks;
create policy "tâches par zone" on tasks for select using (org_id = brain_org_id() and brain_can_read_zone(zone));

drop policy if exists "automatisations : admins et intéressé" on automation_suggestions;
create policy "automatisations : admins et intéressé" on automation_suggestions for select
  using (org_id = brain_org_id() and (brain_is_admin() or user_id = brain_profile_id()));

drop policy if exists "état : membres" on company_status;
create policy "état : membres" on company_status for select using (org_id = brain_org_id());

-- Supabase Realtime (optional: the dashboard uses its own SSE stream, but a Supabase client can subscribe).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table agent_events;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
