-- 011: anonymous usage statistics (admin "Statisztika").
--  * analytics_daily: one counter per (day, event, key). Never a row per visitor: no ids, no IP addresses, no cookies.
--  * track(p): the public map adds to the counters. Only a fixed list of events is accepted; church events need the id
--    of a published church; search words are cleaned and cut to 40 characters.
--  * analytics_report(p_days): everything the admin page shows, admins only. Parish activity comes from church_edits.
-- Needs 010 first. Safe to run twice.

create table if not exists public.analytics_daily (
  day    date   not null,
  event  text   not null,
  key    text   not null default '',
  n      bigint not null default 0,
  primary key (day, event, key)
);
create index if not exists analytics_daily_event_idx on public.analytics_daily (event, day);
-- No policies: nobody reads or writes the table directly, only through the two functions below.
alter table public.analytics_daily enable row level security;
revoke all on public.analytics_daily from anon, authenticated;
grant all on public.analytics_daily to service_role;

create or replace function public.track(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  it  jsonb;
  e   text;
  k   text;
  d   date := (now() at time zone 'Europe/Budapest')::date;
  cnt int  := 0;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return; end if;
  for it in select * from jsonb_array_elements(p) loop
    cnt := cnt + 1;
    exit when cnt > 30;                       -- one call carries a handful of events, never a flood
    e := it->>'e';
    k := coalesce(it->>'k', '');
    if e in ('visit', 'visitor', 'new_visitor', 'install', 'locate') then
      k := '';
    elsif e = 'device' then continue when k not in ('phone', 'tablet', 'desktop');
    elsif e = 'mode'   then continue when k not in ('app', 'browser');
    elsif e = 'tab'    then continue when k not in ('map', 'list', 'saved');
    elsif e = 'filter' then continue when k not in ('mass', 'conf', 'open', 'ev', 'rorate', 'tag', 'day', 'origin');
    elsif e = 'error'  then continue when k not in ('data', 'map');
    elsif e in ('view', 'dir', 'call', 'web', 'save', 'share', 'suggest') then
      continue when k !~ '^[0-9]{1,9}$';
      continue when not exists (select 1 from public.churches c where c.id = k::bigint and c.published);
    elsif e in ('search', 'search_none') then
      -- letters, digits, space, dot and hyphen only; lower case; at most 40 characters
      k := left(btrim(lower(regexp_replace(k, '[^[:alnum:]áéíóöőúüűÁÉÍÓÖŐÚÜŰ .\-]', '', 'g'))), 40);
      continue when char_length(k) < 3;
      -- at most 500 different words a day; the rest are counted together
      if not exists (select 1 from public.analytics_daily a where a.day = d and a.event = e and a.key = k)
         and (select count(*) from public.analytics_daily a where a.day = d and a.event = e) >= 500 then
        k := '(egyéb)';
      end if;
    else
      continue;
    end if;
    insert into public.analytics_daily as a (day, event, key, n) values (d, e, k, 1)
    on conflict (day, event, key) do update set n = a.n + 1;
  end loop;
end $$;
revoke execute on function public.track(jsonb) from public;
grant execute on function public.track(jsonb) to anon, authenticated, service_role;

create or replace function public.analytics_report(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Europe/Budapest')::date;
  d0    date;
  res   jsonb;
begin
  if not public.is_admin() then raise exception 'A statisztikát csak adminisztrátor láthatja.'; end if;
  p_days := least(greatest(coalesce(p_days, 30), 1), 365);
  d0 := today - (p_days - 1);
  select jsonb_build_object(
    'from', d0, 'to', today,
    -- one row per day, also for days without any visit
    'days', (select jsonb_agg(jsonb_build_object('day', g::date,
               'visits',   (select coalesce(sum(n), 0) from public.analytics_daily a where a.day = g::date and a.event = 'visit'),
               'visitors', (select coalesce(sum(n), 0) from public.analytics_daily a where a.day = g::date and a.event = 'visitor'),
               'new',      (select coalesce(sum(n), 0) from public.analytics_daily a where a.day = g::date and a.event = 'new_visitor'),
               'views',    (select coalesce(sum(n), 0) from public.analytics_daily a where a.day = g::date and a.event = 'view')) order by g)
             from generate_series(d0::timestamp, today::timestamp, interval '1 day') g),
    -- simple counters as "event:key" → n
    'totals', (select coalesce(jsonb_object_agg(t.event || ':' || t.key, t.n), '{}'::jsonb) from (
                 select a.event, a.key, sum(a.n) as n from public.analytics_daily a
                 where a.day >= d0 and a.event in ('visit', 'visitor', 'new_visitor', 'install', 'locate', 'device', 'mode', 'tab', 'filter', 'error')
                 group by a.event, a.key) t),
    'actions', (select coalesce(jsonb_object_agg(t.event, t.n), '{}'::jsonb) from (
                 select a.event, sum(a.n) as n from public.analytics_daily a
                 where a.day >= d0 and a.event in ('view', 'dir', 'call', 'web', 'save', 'share', 'suggest', 'search', 'search_none')
                 group by a.event) t),
    'churches', (select coalesce(jsonb_agg(to_jsonb(t) order by t.view desc, t.name), '[]'::jsonb) from (
                 select c.id, c.name, c.city,
                   exists (select 1 from public.services s where s.church_id = c.id) or exists (select 1 from public.dated_services ds where ds.church_id = c.id) as has_times,
                   coalesce(sum(a.n) filter (where a.event = 'view'), 0)    as view,
                   coalesce(sum(a.n) filter (where a.event = 'dir'), 0)     as dir,
                   coalesce(sum(a.n) filter (where a.event = 'call'), 0)    as call,
                   coalesce(sum(a.n) filter (where a.event = 'web'), 0)     as web,
                   coalesce(sum(a.n) filter (where a.event = 'save'), 0)    as save,
                   coalesce(sum(a.n) filter (where a.event = 'share'), 0)   as share,
                   coalesce(sum(a.n) filter (where a.event = 'suggest'), 0) as suggest
                 from public.analytics_daily a join public.churches c on c.id = a.key::bigint
                 where a.day >= d0 and a.event in ('view', 'dir', 'call', 'web', 'save', 'share', 'suggest')
                 group by c.id order by 5 desc, c.name limit 40) t),
    -- the most viewed churches that have no times at all: where filling in data helps the most people
    'no_times', (select coalesce(jsonb_agg(to_jsonb(t) order by t.view desc, t.name), '[]'::jsonb) from (
                 select c.id, c.name, c.city, sum(a.n) as view
                 from public.analytics_daily a join public.churches c on c.id = a.key::bigint
                 where a.day >= d0 and a.event = 'view'
                   and not exists (select 1 from public.services s where s.church_id = c.id)
                   and not exists (select 1 from public.dated_services ds where ds.church_id = c.id)
                 group by c.id order by 4 desc, c.name limit 25) t),
    'searches', (select coalesce(jsonb_agg(to_jsonb(t) order by t.n desc, t.q), '[]'::jsonb) from (
                 select a.key as q, sum(a.n) as n from public.analytics_daily a
                 where a.day >= d0 and a.event = 'search' group by a.key order by 2 desc, 1 limit 30) t),
    'searches_none', (select coalesce(jsonb_agg(to_jsonb(t) order by t.n desc, t.q), '[]'::jsonb) from (
                 select a.key as q, sum(a.n) as n from public.analytics_daily a
                 where a.day >= d0 and a.event = 'search_none' group by a.key order by 2 desc, 1 limit 40) t),
    -- parish activity, from the edit history
    'parish_saves', (select coalesce(jsonb_agg(to_jsonb(t) order by t.at desc), '[]'::jsonb) from (
                 select e.church_id as id, c.name, c.city, coalesce(nullif(e.who, ''), s.display_name, s.email) as who, e.at
                 from public.church_edits e join public.churches c on c.id = e.church_id join public.staff s on s.user_id = e.user_id
                 where s.role = 'parish' order by e.at desc limit 30) t),
    'parish_saves_count', (select count(*) from public.church_edits e join public.staff s on s.user_id = e.user_id
                 where s.role = 'parish' and e.at >= d0),
    'parish_never', (select coalesce(jsonb_agg(to_jsonb(t) order by t.name), '[]'::jsonb) from (
                 select c.id, c.name, c.city, coalesce(s.display_name, s.email) as who
                 from public.staff_churches sc join public.staff s on s.user_id = sc.user_id join public.churches c on c.id = sc.church_id
                 where s.role = 'parish' and not exists (select 1 from public.church_edits e where e.church_id = sc.church_id and e.user_id = sc.user_id)
                 order by c.name limit 50) t),
    'parish_stale', (select coalesce(jsonb_agg(to_jsonb(t) order by t.at nulls first, t.name), '[]'::jsonb) from (
                 select c.id, c.name, c.city, c.parish_updated_at as at
                 from public.churches c
                 where exists (select 1 from public.staff_churches sc join public.staff s on s.user_id = sc.user_id where sc.church_id = c.id and s.role = 'parish')
                   and (c.parish_updated_at is null or c.parish_updated_at < now() - interval '180 days')
                 order by c.parish_updated_at nulls first, c.name limit 30) t),
    'suggestions', jsonb_build_object(
                 'received', (select count(*) from public.suggestions sg where sg.created_at >= d0),
                 'pending',  (select count(*) from public.suggestions sg where sg.status = 'pending')),
    'coverage', jsonb_build_object(
                 'churches',   (select count(*) from public.churches c where c.published),
                 'with_times', (select count(*) from public.churches c where c.published
                                  and (exists (select 1 from public.services s where s.church_id = c.id) or exists (select 1 from public.dated_services ds where ds.church_id = c.id))),
                 'parish_managed', (select count(distinct sc.church_id) from public.staff_churches sc join public.staff s on s.user_id = sc.user_id where s.role = 'parish'))
  ) into res;
  return res;
end $$;
revoke execute on function public.analytics_report(int) from public, anon;
grant execute on function public.analytics_report(int) to authenticated, service_role;
