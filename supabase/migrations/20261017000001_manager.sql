-- Organigramme : chaque poste peut être rattaché à un autre (la page « Équipe et accès » le dessine).
alter table profiles add column if not exists manager_id uuid references profiles(id) on delete set null;
create index if not exists profiles_manager_idx on profiles (manager_id);
