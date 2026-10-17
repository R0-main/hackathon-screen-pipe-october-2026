-- Requests to join a company: the team message (one code per company, in brain_settings under
-- `join:<org_id>`) creates a pending request, pre-filled by the requester's Claude. An admin accepts it (the account
-- is created with the fingerprint of the token generated on the computer, never sent in clear) or declines it.
-- Read and written only by the API (owner role): RLS enabled without a policy.

create table if not exists join_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text,
  title text,
  email text,
  hostname text,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  profile_id uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists join_requests_org_idx on join_requests (org_id, status, created_at desc);

alter table join_requests enable row level security;
revoke all on join_requests from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on join_requests from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on join_requests from authenticated;
  end if;
end $$;
