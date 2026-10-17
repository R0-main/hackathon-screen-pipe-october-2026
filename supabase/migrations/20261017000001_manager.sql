-- Org chart: each person can report to another one (the "Team and access" page draws it).
alter table profiles add column if not exists manager_id uuid references profiles(id) on delete set null;
create index if not exists profiles_manager_idx on profiles (manager_id);
