-- Migration 002: summer/winter schedules, feast-day schedules and Rorate Masses.
-- Run this once in the Supabase SQL Editor if you already ran supabase/schema.sql before 26 Oct 2026.
-- (A fresh install only needs schema.sql, which already contains these changes.) Safe to re-run.

-- services.period: 'all' (default), 'summer' (summer time only) or 'winter' (winter time only)
alter table public.services add column if not exists period text not null default 'all';
alter table public.services drop constraint if exists services_period_check;
alter table public.services add constraint services_period_check check (period in ('all','summer','winter'));

-- services.kind gains 'rorate' (only counts during Advent)
alter table public.services drop constraint if exists services_kind_check;
alter table public.services add constraint services_kind_check check (kind in ('mass','confession','adoration','rorate'));

-- services.feast: when set, the row belongs to that feast's special schedule and its days are ignored
alter table public.services add column if not exists feast text;
alter table public.services drop constraint if exists services_feast_check;
alter table public.services add constraint services_feast_check check (feast is null or feast ~ '^[a-z0-9_]{1,30}$');
alter table public.services drop constraint if exists services_days_check;
alter table public.services add constraint services_days_check
  check (days <@ array[0,1,2,3,4,5,6]::smallint[] and (feast is not null or cardinality(days) > 0));

-- churches.feast_sunday: feasts on which this church follows its Sunday schedule
alter table public.churches add column if not exists feast_sunday text[] not null default '{}';

-- public_data(): adds period, feast and feast_sunday
create or replace function public.public_data() returns jsonb
language sql stable security invoker set search_path = public as $$
  -- Empty and null fields are left out to keep the download small (most churches have no times yet).
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', c.id, 'name', c.name, 'city', c.city, 'address', c.address, 'rite', c.rite,
    'lat', round(c.lat::numeric, 5), 'lon', round(c.lon::numeric, 5), 'website', c.website, 'phone', c.phone,
    'open_only_services', nullif(c.open_only_services, false), 'feast_sunday', nullif(c.feast_sunday, '{}'),
    'hours', (select jsonb_agg(jsonb_build_object('days', h.days, 'opens', to_char(h.opens,'HH24:MI'), 'closes', to_char(h.closes,'HH24:MI')))
              from opening_hours h where h.church_id = c.id),
    'services', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kind', s.kind, 'days', s.days, 'start', to_char(s.start_time,'HH24:MI'),
                   'end', to_char(s.end_time,'HH24:MI'), 'note', s.note, 'period', nullif(s.period,'all'), 'feast', s.feast)) order by s.start_time)
              from services s where s.church_id = c.id),
    'events', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('date', e.date, 'start', to_char(e.start_time,'HH24:MI'), 'title', e.title, 'note', e.note)) order by e.date)
              from events e where e.church_id = c.id and e.date >= current_date - 1 and e.date <= current_date + 120)
  ))), '[]'::jsonb)
  from churches c where c.published;
$$;
grant execute on function public.public_data() to anon, authenticated;

-- save_church(): stores period, feast and feast_sunday
create or replace function public.save_church(p jsonb) returns bigint
language plpgsql security invoker set search_path = public as $$
declare cid bigint := nullif(p->>'id','')::bigint;
        fs text[] := array(select jsonb_array_elements_text(coalesce(p->'feast_sunday','[]'::jsonb)));
begin
  if cid is null then
    insert into churches (name, city, address, rite, lat, lon, website, phone, notes, open_only_services, published, feast_sunday)
    values (p->>'name', coalesce(p->>'city',''), coalesce(p->>'address',''), coalesce(p->>'rite','rk'),
            (p->>'lat')::float8, (p->>'lon')::float8, nullif(p->>'website',''), nullif(p->>'phone',''), nullif(p->>'notes',''),
            coalesce((p->>'open_only_services')::boolean, false), coalesce((p->>'published')::boolean, true), fs)
    returning id into cid;
  else
    update churches set
      name = p->>'name', city = coalesce(p->>'city',''), address = coalesce(p->>'address',''),
      rite = coalesce(p->>'rite','rk'), lat = (p->>'lat')::float8, lon = (p->>'lon')::float8,
      website = nullif(p->>'website',''), phone = nullif(p->>'phone',''), notes = nullif(p->>'notes',''),
      open_only_services = coalesce((p->>'open_only_services')::boolean, false),
      published = coalesce((p->>'published')::boolean, true), feast_sunday = fs
    where id = cid;
    if not found then raise exception 'Nincs ilyen templom, vagy nincs jogod szerkeszteni (id %)', cid; end if;
  end if;

  delete from opening_hours where church_id = cid;
  insert into opening_hours (church_id, days, opens, closes)
    select cid, array(select jsonb_array_elements_text(x->'days')::smallint), (x->>'opens')::time, (x->>'closes')::time
    from jsonb_array_elements(coalesce(p->'hours','[]'::jsonb)) x;

  delete from services where church_id = cid;
  insert into services (church_id, kind, days, start_time, end_time, note, period, feast)
    select cid, x->>'kind', array(select jsonb_array_elements_text(coalesce(x->'days','[]'::jsonb))::smallint),
           (x->>'start')::time, nullif(x->>'end','')::time, nullif(x->>'note',''),
           coalesce(nullif(x->>'period',''),'all'), nullif(x->>'feast','')
    from jsonb_array_elements(coalesce(p->'services','[]'::jsonb)) x;

  delete from events where church_id = cid;
  insert into events (church_id, date, start_time, title, note)
    select cid, (x->>'date')::date, nullif(x->>'start','')::time, x->>'title', nullif(x->>'note','')
    from jsonb_array_elements(coalesce(p->'events','[]'::jsonb)) x;

  return cid;
end $$;
grant execute on function public.save_church(jsonb) to authenticated;
