-- A zone's projects: folder names or git repositories (owner/repo) whose AI sessions always land in the zone
-- (projectZone, packages/core/src/zones.ts). Empty for the zones that existed before.
alter table zones add column if not exists projects text[] not null default '{}';
