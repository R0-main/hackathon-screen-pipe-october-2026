-- Minimal "auth" schema to apply the migrations on a Postgres without Supabase (local tests).
create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
