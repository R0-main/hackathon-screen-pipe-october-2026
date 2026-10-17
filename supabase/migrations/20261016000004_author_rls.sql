-- RLS policies aligned on the rules applied by the API (lib/access.ts, lib/brain.ts).

-- Oversight: authors always see their own knowledge, even filed in a zone they do not read
-- (everyone feeds the brain: writing is not restricted by zone).
drop policy if exists "lecture par zone" on knowledge_items;
create policy "lecture par zone" on knowledge_items for select
  using (org_id = brain_org_id() and (brain_can_read_zone(zone) or author_id = brain_profile_id()));

drop policy if exists "liens des items lisibles" on edges;
create policy "liens des items lisibles" on edges for select
  using (exists (
    select 1 from knowledge_items k
    where k.id = item_id and (brain_can_read_zone(k.zone) or k.author_id = brain_profile_id())
  ));

-- Events: the API shows everyone that a zone lights up, but the content (summary, fingerprint, session)
-- is only visible to the author, the admins, or whoever reads ALL the zones of the event (never for an event
-- without a zone). A policy does not hide columns: with direct access, only these rows are readable.
-- The column comment below is replaced by an English one in 20261018000001_english.sql.
drop policy if exists "événements visibles" on agent_events;
create policy "événements visibles" on agent_events for select
  using (org_id = brain_org_id() and (
    user_id = brain_profile_id()
    or brain_is_admin()
    or (cardinality(zones) > 0 and not exists (select 1 from unnest(zones) z where not brain_can_read_zone(z)))
  ));

comment on column zone_access.can_write is
  'Réservé : non appliqué. Tout membre peut nourrir n''importe quelle zone existante ; seule la lecture est restreinte.';
