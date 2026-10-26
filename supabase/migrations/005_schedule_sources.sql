-- Migration 005: schedule notes and sources, for importing diocesan Mass schedules (first: Székesfehérvár).
-- Run once in the Supabase SQL Editor (after 004). Safe to re-run. A fresh install only needs schema.sql.

alter table public.churches add column if not exists schedule_note text;            -- public note shown with the schedule
alter table public.churches add column if not exists schedule_source text;          -- e.g. 'szfvar' when times came from an import
alter table public.churches add column if not exists schedule_source_url text;
alter table public.churches add column if not exists schedule_updated date;         -- the source's own "updated" date
alter table public.churches add column if not exists source_ref text;               -- the source's key for this church (stable across runs)
alter table public.churches add column if not exists location_approx boolean not null default false;  -- placed at the settlement centre; to check
alter table public.churches add column if not exists schedule_locked boolean not null default false;  -- checked by an editor: imports must not overwrite
create unique index if not exists churches_source_ref_idx on public.churches (schedule_source, source_ref) where source_ref is not null;

-- Used by import jobs (secret key only). Replaces a church's regular times (and the feast rows the payload
-- brings) with the imported ones, and stores the note and source. Opening hours, events and other feasts stay.
-- Skips churches an editor locked, and churches whose times were entered by hand, unless force is set.
create or replace function public.import_church_schedule(p jsonb) returns text
language plpgsql security invoker set search_path = public as $$
declare cid bigint := (p->>'church_id')::bigint; src text := p->>'source';
        cur_src text; is_locked boolean; has_regular boolean;
        feasts text[] := array(select distinct x->>'feast' from jsonb_array_elements(coalesce(p->'services','[]'::jsonb)) x where x->>'feast' is not null);
begin
  select schedule_source, schedule_locked into cur_src, is_locked from churches where id = cid;
  if not found then return 'missing'; end if;
  if is_locked then return 'locked'; end if;
  has_regular := exists (select 1 from services where church_id = cid and feast is null);
  if has_regular and cur_src is distinct from src and not coalesce((p->>'force')::boolean, false) then return 'manual'; end if;

  update churches set schedule_note = nullif(p->>'note',''), schedule_source = src, schedule_source_url = nullif(p->>'source_url',''),
         schedule_updated = nullif(p->>'updated','')::date where id = cid;
  delete from services where church_id = cid and (feast is null or feast = any(feasts));
  insert into services (church_id, kind, days, start_time, end_time, note, period, feast)
    select cid, x->>'kind', array(select jsonb_array_elements_text(coalesce(x->'days','[]'::jsonb))::smallint),
           (x->>'start')::time, nullif(x->>'end','')::time, nullif(x->>'note',''), coalesce(nullif(x->>'period',''),'all'), nullif(x->>'feast','')
    from jsonb_array_elements(coalesce(p->'services','[]'::jsonb)) x;
  return 'updated';
end $$;
revoke execute on function public.import_church_schedule(jsonb) from public, anon, authenticated;
grant execute on function public.import_church_schedule(jsonb) to service_role;

create or replace function public.public_data() returns jsonb
language sql stable security invoker set search_path = public as $$
  -- Empty and null fields are left out to keep the download small (most churches have no times yet).
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', c.id, 'name', c.name, 'city', c.city, 'address', c.address, 'rite', c.rite,
    'lat', round(c.lat::numeric, 5), 'lon', round(c.lon::numeric, 5), 'website', c.website, 'phone', c.phone,
    'imp', coalesce(c.importance_manual, c.importance_auto),
    'open_only_services', nullif(c.open_only_services, false),
    'schedule_note', c.schedule_note, 'schedule_source', c.schedule_source, 'schedule_source_url', c.schedule_source_url,
    'schedule_updated', c.schedule_updated, 'location_approx', nullif(c.location_approx, false), 'feast_sunday', nullif(c.feast_sunday, '{}'),
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

create or replace function public.save_church(p jsonb) returns bigint
language plpgsql security invoker set search_path = public as $$
declare cid bigint := nullif(p->>'id','')::bigint;
        fs text[] := array(select jsonb_array_elements_text(coalesce(p->'feast_sunday','[]'::jsonb)));
        imp smallint := nullif(p->>'importance_manual','')::smallint;
        snote text := nullif(p->>'schedule_note','');
        approx boolean := coalesce((p->>'location_approx')::boolean, false);
        locked boolean := coalesce((p->>'schedule_locked')::boolean, false);
begin
  if cid is null then
    insert into churches (name, city, address, rite, lat, lon, website, phone, notes, open_only_services, published, feast_sunday, importance_manual, importance_auto, schedule_note, location_approx, schedule_locked)
    values (p->>'name', coalesce(p->>'city',''), coalesce(p->>'address',''), coalesce(p->>'rite','rk'),
            (p->>'lat')::float8, (p->>'lon')::float8, nullif(p->>'website',''), nullif(p->>'phone',''), nullif(p->>'notes',''),
            coalesce((p->>'open_only_services')::boolean, false), coalesce((p->>'published')::boolean, true), fs, imp, 50, snote, approx, locked)
    returning id into cid;
  else
    update churches set
      name = p->>'name', city = coalesce(p->>'city',''), address = coalesce(p->>'address',''),
      rite = coalesce(p->>'rite','rk'), lat = (p->>'lat')::float8, lon = (p->>'lon')::float8,
      website = nullif(p->>'website',''), phone = nullif(p->>'phone',''), notes = nullif(p->>'notes',''),
      open_only_services = coalesce((p->>'open_only_services')::boolean, false),
      published = coalesce((p->>'published')::boolean, true), feast_sunday = fs, importance_manual = imp,
      schedule_note = snote, location_approx = approx, schedule_locked = locked
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

drop view if exists public.admin_church_list;
create or replace view public.admin_church_list with (security_invoker = true) as
select
  c.id, c.name, c.city, c.address, c.rite, c.published, c.updated_at,
  (c.osm_id is not null) as from_osm,
  c.importance_auto, c.importance_manual, c.schedule_source, c.schedule_updated, c.location_approx, c.schedule_locked,
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
