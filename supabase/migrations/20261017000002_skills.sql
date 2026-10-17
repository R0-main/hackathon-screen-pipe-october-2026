-- Skills de l'entreprise : chaque skill Claude Code (SKILL.md et les scripts qu'il utilise) est conservé dans le cerveau.
-- Publier demande un droit (profiles.can_publish_skills, les admins l'ont toujours). Un skill attribué à un cortex
-- (une zone) n'est donné qu'à ceux qui lisent cette zone ; sans zone, il va à toute l'entreprise.

alter table profiles add column if not exists can_publish_skills boolean not null default false;

create table if not exists skills (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  description text not null default '',
  -- Cortex (zone) du skill ; null : toute l'entreprise.
  zone text,
  -- [{ path, content }] : SKILL.md à la racine et les scripts, en texte.
  files jsonb not null default '[]',
  author_id uuid references profiles(id) on delete set null,
  updated_by uuid references profiles(id) on delete set null,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create index if not exists skills_zone_idx on skills (org_id, zone);

alter table skills enable row level security;

drop policy if exists "skills par cortex" on skills;
create policy "skills par cortex" on skills for select
  using (org_id = brain_org_id() and (zone is null or brain_can_read_zone(zone)));
