-- English-only product. Zone ids produit → product, compta → finance, direction → leadership; default zones,
-- demo visitors, row-level security policies and column comments in English.
-- Idempotent and safe on an empty database: every step only touches rows that still have the old values.

-- Old zone id → new zone id (null when the id is unchanged). Temporary: dropped at the end of the session.
create or replace function pg_temp.english_zone_id(old text) returns text language sql immutable as $$
  select case old when 'produit' then 'product' when 'compta' then 'finance' when 'direction' then 'leadership' end
$$;

-- 1. Zone ids. zone_access references zones (org_id, id) without "on update cascade": the new zone is created (or
--    the existing one is kept if the company already has it), every reference moves to it, then the old zone is
--    deleted (its zone_access rows go with it).
insert into zones (org_id, id, name, description, color, keywords, position, created_at)
  select org_id, pg_temp.english_zone_id(id), name, description, color, keywords, position, created_at
  from zones where pg_temp.english_zone_id(id) is not null
  on conflict (org_id, id) do nothing;

insert into zone_access (org_id, user_id, zone_id, can_write)
  select org_id, user_id, pg_temp.english_zone_id(zone_id), can_write
  from zone_access where pg_temp.english_zone_id(zone_id) is not null
  on conflict (user_id, zone_id) do nothing;

update knowledge_items set zone = pg_temp.english_zone_id(zone) where pg_temp.english_zone_id(zone) is not null;
update tasks set zone = pg_temp.english_zone_id(zone) where pg_temp.english_zone_id(zone) is not null;
update automation_suggestions set zone = pg_temp.english_zone_id(zone) where pg_temp.english_zone_id(zone) is not null;
update skills set zone = pg_temp.english_zone_id(zone) where pg_temp.english_zone_id(zone) is not null;

-- Events: every id of the array renamed, without duplicates, in their first order.
update agent_events e set zones = (
    select coalesce(array_agg(z order by n), '{}')
    from (
      select coalesce(pg_temp.english_zone_id(z), z) as z, min(n) as n
      from unnest(e.zones) with ordinality as t(z, n)
      group by 1
    ) renamed
  )
  where e.zones && array['produit', 'compta', 'direction'];

-- "Where does the company stand" summary: content.zones[].zone.
update company_status set content = jsonb_set(content, '{zones}', (
    select coalesce(jsonb_agg(
      case when pg_temp.english_zone_id(z->>'zone') is not null
        then jsonb_set(z, '{zone}', to_jsonb(pg_temp.english_zone_id(z->>'zone')))
        else z end
      order by n), '[]'::jsonb)
    from jsonb_array_elements(content->'zones') with ordinality as t(z, n)
  ))
  where jsonb_typeof(content->'zones') = 'array'
    and exists (select 1 from jsonb_array_elements(content->'zones') z where pg_temp.english_zone_id(z->>'zone') is not null);

-- Company settings kept as JSON text: zone of each connector, and the onboarding proposal waiting for review
-- (zones[].id, items[].zone). Both are written by JSON.stringify, without spaces.
update brain_settings
  set value = regexp_replace(
    regexp_replace(
      regexp_replace(value, '"(zone|id)":"produit"', '"\1":"product"', 'g'),
      '"(zone|id)":"compta"', '"\1":"finance"', 'g'),
    '"(zone|id)":"direction"', '"\1":"leadership"', 'g')
  where (key like 'org:connectors:%' or key like 'org:onboarding-draft:%')
    and value ~ '"(zone|id)":"(produit|compta|direction)"';

delete from zones where pg_temp.english_zone_id(id) is not null;

-- 2. Default zones: English name, description and keywords, only where the company still has the old defaults
--    (matched by their md5, so an edited zone keeps what its admin wrote).
update zones z set
    name = case when md5(z.name) = d.old_name then d.name else z.name end,
    description = case when md5(z.description) = d.old_description then d.description else z.description end,
    keywords = case when md5(array_to_string(z.keywords, ',')) = d.old_keywords then d.keywords else z.keywords end
  from (values
    ('dev', '55f37d1fd483f6a85379640fe51aafa8', 'Dev', 'c2ad86ca9272cfd37e5173e5585f0e63', 'Code, architecture, infrastructure, deployments, bugs.',
     'a29e1ea6a24be128f17010aab82cffee', array['code', 'bug', 'bugs', 'deploy', 'deployment', 'api', 'repo', 'git', 'github', 'gitlab', 'pull', 'merge', 'test', 'tests', 'build', 'ci', 'cicd', 'backend', 'frontend', 'database', 'sql', 'postgres', 'supabase', 'migration', 'server', 'production', 'docker', 'typescript', 'react', 'next', 'node', 'python', 'endpoint', 'refactor', 'prod', 'staging', 'infra', 'infrastructure', 'kubernetes', 'aws', 'vercel', 'auth', 'webhook', 'stack', 'lib', 'library', 'function', 'error', 'crash', 'logs', 'performance', 'schema', 'commit', 'branch', 'release']),
    ('product', 'e30e2cb9aa296049a2d8ba40f41b7f8a', 'Product', 'f87073a4585c0ec473244eca800b9b23', 'Roadmap, specs, design, user feedback.',
     '7430cb6424a12150d5d88fa5491d5292', array['product', 'roadmap', 'feature', 'features', 'spec', 'specs', 'user', 'users', 'ux', 'ui', 'design', 'mockup', 'wireframe', 'figma', 'persona', 'feedback', 'onboarding', 'journey', 'prioritization', 'backlog', 'sprint', 'mvp', 'experiment', 'metric', 'metrics', 'retention', 'activation', 'interview']),
    ('sales', '11ff9f68afb6b8b5b8eda218d7c83a65', 'Sales', '51f04f8a773d09bf02384304a9fb4eb7', 'Prospects, customers, pipeline, quotes, partnerships.',
     'cea20936f17072ab2348f325815e557d', array['client', 'clients', 'customer', 'customers', 'prospect', 'prospects', 'prospecting', 'quote', 'quotes', 'crm', 'hubspot', 'pipeline', 'deal', 'deals', 'sale', 'sales', 'meeting', 'demo', 'proposal', 'pricing', 'price', 'prices', 'contract', 'signature', 'lead', 'leads', 'partner', 'partnership', 'tradeshow', 'followup', 'churn', 'upsell', 'subscription']),
    ('finance', 'c2757ef3be91d5dd7d202ae55899d2d2', 'Finance', 'ff66c0260dc63933ef7769d96e787a1f', 'Invoicing, cash, closing, VAT, payroll.',
     'a080fc631b1d94e1cab17e657655acb8', array['finance', 'accounting', 'accountant', 'bookkeeping', 'invoice', 'invoices', 'invoicing', 'billing', 'vat', 'tax', 'closing', 'balance', 'cash', 'treasury', 'bank', 'statement', 'statements', 'reconciliation', 'reconcile', 'qonto', 'pennylane', 'payroll', 'salary', 'salaries', 'budget', 'expense', 'expenses', 'receipt', 'fiscal', 'burn', 'runway', 'refund', 'credit']),
    ('support', 'db5eb84117d06047c97c9a0191b5fffe', 'Support', '1b34a46958ae91617b01e41781b63c03', 'Tickets, customer incidents, FAQ, support procedures.',
     '03fd5baa14e239435d3629c2cb9681aa', array['support', 'ticket', 'tickets', 'incident', 'incidents', 'faq', 'zendesk', 'intercom', 'helpdesk', 'complaint', 'refund', 'outage', 'blocked', 'help', 'question', 'escalation', 'sla', 'hotline']),
    ('leadership', '02674a4ef33e11c879283629996c8ff8', 'Leadership', '7c0f5cc8ec0cf30dfdd59224b86ef185', 'Strategy, goals, fundraising, hiring, organization.',
     'cccb9708d931b31964434825599bef80', array['strategy', 'goal', 'goals', 'objective', 'objectives', 'okr', 'okrs', 'fundraising', 'funding', 'investor', 'investors', 'board', 'hiring', 'recruiting', 'recruitment', 'hr', 'organization', 'vision', 'kpi', 'kpis', 'quarter', 'q1', 'q2', 'q3', 'q4', 'committee', 'founders', 'valuation', 'plan', 'leadership'])
  ) as d(id, old_name, name, old_description, description, old_keywords, keywords)
  where z.id = d.id
    and (md5(z.name) = d.old_name or md5(z.description) = d.old_description or md5(array_to_string(z.keywords, ',')) = d.old_keywords);

-- 3. Demo visitors (title of the old demo, "<word> 1234" names): "Demo visitor", "Visitor 1234".
update profiles set
    title = 'Demo visitor',
    name = case when name ~ '^\S+ \d{4}$' then 'Visitor ' || substring(name from '\d{4}$') else name end
  where md5(title) = 'c295d711ea8ca6e1d0eaa448f288c5f7';

-- 4. Row-level security policies with English names (same rules).
do $$
declare
  p record;
begin
  for p in select * from (values
    ('orgs', 'membres : lire son org', 'members: read their org'),
    ('profiles', 'membres : lire l''équipe', 'members: read the team'),
    ('zones', 'membres : lire les zones', 'members: read the zones'),
    ('zone_access', 'membres : lire ses accès', 'members: read their access'),
    ('zone_access', 'admins : gérer les accès', 'admins: manage access'),
    ('knowledge_items', 'lecture par zone', 'read by zone'),
    ('knowledge_items', 'l''auteur supprime ses items', 'authors delete their items'),
    ('entities', 'membres : lire les entités', 'members: read the entities'),
    ('edges', 'liens des items lisibles', 'links of readable items'),
    ('agent_events', 'événements visibles', 'visible events'),
    ('tasks', 'tâches par zone', 'tasks by zone'),
    ('automation_suggestions', 'automatisations : admins et intéressé', 'automations: admins and the person concerned'),
    ('company_status', 'état : membres', 'status: members'),
    ('skills', 'skills par cortex', 'skills by cortex')
  ) as t(tbl, old_name, new_name) loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = p.tbl and policyname = p.old_name)
      and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = p.tbl and policyname = p.new_name) then
      execute format('alter policy %I on %I rename to %I', p.old_name, p.tbl, p.new_name);
    end if;
  end loop;
end $$;

comment on column zone_access.can_write is
  'Reserved: not enforced. Any member can feed any existing zone; only reading is restricted.';

drop function pg_temp.english_zone_id(text);
