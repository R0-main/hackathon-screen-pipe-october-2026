-- Schéma « auth » minimal pour appliquer les migrations sur un Postgres sans Supabase (tests locaux).
create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
