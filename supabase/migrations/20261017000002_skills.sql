-- Company skills: each Claude Code skill (SKILL.md and the scripts it uses) is kept in the brain.
-- Publishing needs a permission (profiles.can_publish_skills, admins always have it). A skill assigned to a cortex
-- (a zone) is only given to those who read that zone; without a zone, it goes to the whole company.

alter table profiles add column if not exists can_publish_skills boolean not null default false;

create table if not exists skills (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  description text not null default '',
  -- Cortex (zone) of the skill; null: the whole company.
  zone text,
  -- [{ path, content }]: SKILL.md at the root and the scripts, as text.
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
