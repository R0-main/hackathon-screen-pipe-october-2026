-- Tasks imported by a connector (Linear, Todoist): where they come from, their id in the tool (to update them
-- without duplicates) and the link to open them. Tasks extracted from AI sessions keep these columns null.

alter table tasks add column if not exists external_source text;
alter table tasks add column if not exists external_id text;
alter table tasks add column if not exists external_url text;
create unique index if not exists tasks_external_idx on tasks (org_id, external_source, external_id) where external_id is not null;
