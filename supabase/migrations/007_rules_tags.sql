-- 007: structured schedule rules instead of free-text notes.
--  * every / anchor: every 2nd, 3rd… week, counted from a date it happens on ("kéthetente")
--  * tags: language and kind of Mass (családos, gitáros, csendes, előesti, igeliturgia is lehet, változhat…)
--  * kind 'prayer': Liturgy of the Hours, rosary, Stations of the Cross…
--  * periods: advent, lent, eastertide (move with Easter / Advent), school year, summer holiday
-- Safe to run twice.
alter table public.services add column if not exists every smallint, add column if not exists anchor date, add column if not exists tags text[];
alter table public.services drop constraint if exists services_kind_check, drop constraint if exists services_period_check,
  drop constraint if exists services_every_check, drop constraint if exists services_tags_check, drop constraint if exists services_anchor_check;
alter table public.services
  add constraint services_kind_check check (kind in ('mass','confession','adoration','rorate','prayer')),
  add constraint services_period_check check (period in ('all','summer','winter','autumn','spring','advent','lent','eastertide','school','holiday')),
  add constraint services_every_check check (every is null or every between 2 and 8),
  add constraint services_anchor_check check ((every is null) = (anchor is null)),
  add constraint services_tags_check check (tags is null or array_to_string(tags, ' ') ~ '^((lang:[a-z]{2,3}|family|student|youth|university|guitar|organ|choir|silent|vigil|word|confession|traditional|irregular)( |$))+$');

-- Inserts schedule rows given as JSON (used by save_church and import_church_schedule). Runs with the caller's rights.
create or replace function public.insert_services(cid bigint, rows jsonb) returns void
language sql security invoker set search_path = public as $$
  insert into services (church_id, kind, days, start_time, end_time, note, period, feast, valid, weeks, every, anchor, tags)
    select cid, x->>'kind', array(select jsonb_array_elements_text(coalesce(x->'days','[]'::jsonb))::smallint),
           (x->>'start')::time, nullif(x->>'end','')::time, nullif(x->>'note',''),
           coalesce(nullif(x->>'period',''),'all'), nullif(x->>'feast',''), nullif(x->>'valid',''),
           case when jsonb_typeof(x->'weeks') = 'array' and jsonb_array_length(x->'weeks') > 0
                then array(select jsonb_array_elements_text(x->'weeks')::smallint) end,
           case when coalesce((x->>'every')::int, 1) >= 2 and nullif(x->>'anchor','') is not null then (x->>'every')::smallint end,
           case when coalesce((x->>'every')::int, 1) >= 2 then nullif(x->>'anchor','')::date end,
           case when jsonb_typeof(x->'tags') = 'array' and jsonb_array_length(x->'tags') > 0
                then array(select distinct jsonb_array_elements_text(x->'tags')) end
    from jsonb_array_elements(coalesce(rows,'[]'::jsonb)) x;
$$;
revoke execute on function public.insert_services(bigint, jsonb) from public, anon;
grant execute on function public.insert_services(bigint, jsonb) to authenticated, service_role;

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
         schedule_updated = nullif(p->>'updated','')::date,
         source_ref = coalesce(nullif(p->>'source_ref',''), source_ref),
         city = case when coalesce(city,'') = '' then coalesce(p->>'city','') else city end,
         address = case when coalesce(address,'') = '' then coalesce(p->>'address','') else address end
   where id = cid;
  delete from services where church_id = cid and (feast is null or feast = any(feasts));
  perform public.insert_services(cid, p->'services');
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
                   'end', to_char(s.end_time,'HH24:MI'), 'note', s.note, 'period', nullif(s.period,'all'), 'feast', s.feast, 'valid', s.valid, 'weeks', s.weeks,
                   'every', s.every, 'anchor', s.anchor, 'tags', s.tags)) order by s.start_time)
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
  perform public.insert_services(cid, p->'services');

  delete from events where church_id = cid;
  insert into events (church_id, date, start_time, title, note)
    select cid, (x->>'date')::date, nullif(x->>'start','')::time, x->>'title', nullif(x->>'note','')
    from jsonb_array_elements(coalesce(p->'events','[]'::jsonb)) x;

  return cid;
end $$;
grant execute on function public.save_church(jsonb) to authenticated;
