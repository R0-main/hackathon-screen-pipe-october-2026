-- The core: the zone at the center of every brain, which every member reads (CORE_ZONE, packages/core/src/zones.ts):
-- what anyone in the company needs (vision, mission, what the company does, values, key figures).
-- The stores create it the first time a company lists its zones; here, for the companies that already exist.
insert into zones (org_id, id, name, description, color, keywords, position)
  select o.id, 'core', 'Core',
    'What everyone in the company needs: vision, mission, what the company does, its customers, values, key figures, how it works.',
    '#8c8c85',
    array['vision', 'mission', 'values', 'culture', 'manifesto', 'positioning', 'pitch', 'glossary', 'handbook', 'charter', 'company-wide'],
    -1
  from orgs o
  on conflict (org_id, id) do nothing;

-- Direct access (RLS): every member of the company reads the core, like the API does (lib/access.ts). The policies keep
-- their org_id = brain_org_id() condition: the core of a company is only read by its own members.
create or replace function brain_can_read_zone(z text) returns boolean
language sql stable security definer set search_path = public as $$
  select (z = 'core' and brain_profile_id() is not null) or brain_is_admin() or exists (
    select 1 from zone_access za where za.user_id = brain_profile_id() and za.zone_id = z
  )
$$;
