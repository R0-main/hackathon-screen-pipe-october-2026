-- Alignement des politiques RLS sur les règles appliquées par l'API (lib/access.ts, lib/brain.ts).

-- Droit de regard : l'auteur voit toujours ses connaissances, même rangées dans une zone qu'il ne lit pas
-- (tout le monde nourrit le cerveau : l'écriture n'est pas restreinte par zone).
drop policy if exists "lecture par zone" on knowledge_items;
create policy "lecture par zone" on knowledge_items for select
  using (org_id = brain_org_id() and (brain_can_read_zone(zone) or author_id = brain_profile_id()));

drop policy if exists "liens des items lisibles" on edges;
create policy "liens des items lisibles" on edges for select
  using (exists (
    select 1 from knowledge_items k
    where k.id = item_id and (brain_can_read_zone(k.zone) or k.author_id = brain_profile_id())
  ));

-- Événements : l'API montre à tout le monde qu'une zone s'allume, mais le contenu (résumé, empreinte, session)
-- n'est visible que de l'auteur, des admins, ou de qui lit TOUTES les zones de l'événement (jamais pour un événement
-- sans zone). Une politique ne masque pas de colonnes : en accès direct, seules ces lignes-là sont lisibles.
drop policy if exists "événements visibles" on agent_events;
create policy "événements visibles" on agent_events for select
  using (org_id = brain_org_id() and (
    user_id = brain_profile_id()
    or brain_is_admin()
    or (cardinality(zones) > 0 and not exists (select 1 from unnest(zones) z where not brain_can_read_zone(z)))
  ));

comment on column zone_access.can_write is
  'Réservé : non appliqué. Tout membre peut nourrir n''importe quelle zone existante ; seule la lecture est restreinte.';
