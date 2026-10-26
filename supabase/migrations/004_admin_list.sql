-- Migration 004: overview view for filtering churches in the admin panel.
-- Run once in the Supabase SQL Editor (after 003). Safe to re-run. A fresh install only needs schema.sql.
-- security_invoker: the view runs with the viewer's rights, so the access rules of the underlying tables still apply.

create or replace view public.admin_church_list with (security_invoker = true) as
select
  c.id, c.name, c.city, c.address, c.rite, c.published, c.updated_at,
  (c.osm_id is not null) as from_osm,
  c.importance_auto, c.importance_manual,
  coalesce(c.importance_manual, c.importance_auto) as importance,
  -- accent-free search text, so "kalocsa" and "kalócsa", "szekesfehervar" and "székesfehérvár" match
  translate(lower(c.name || ' ' || c.city || ' ' || c.address), 'áéíóöőúüű', 'aeiooouuu') as search,
  (select count(*) from public.services s where s.church_id = c.id and s.feast is null)::int as n_services,
  exists (select 1 from public.services s where s.church_id = c.id and s.feast is null and s.kind = 'mass') as has_mass,
  exists (select 1 from public.services s where s.church_id = c.id and s.feast is null and s.kind = 'confession') as has_confession,
  exists (select 1 from public.services s where s.church_id = c.id and s.feast is null and s.kind = 'rorate') as has_rorate,
  exists (select 1 from public.services s where s.church_id = c.id and s.feast is null and s.period <> 'all') as has_seasonal,
  (cardinality(c.feast_sunday) > 0 or exists (select 1 from public.services s where s.church_id = c.id and s.feast is not null)) as has_feast,
  (c.open_only_services or exists (select 1 from public.opening_hours h where h.church_id = c.id)) as has_hours,
  (select count(*) from public.events e where e.church_id = c.id and e.date >= current_date)::int as n_events,
  (select count(*) from public.suggestions g where g.church_id = c.id and g.status = 'pending')::int as n_pending
from public.churches c;

revoke all on public.admin_church_list from anon;
grant select on public.admin_church_list to authenticated;
