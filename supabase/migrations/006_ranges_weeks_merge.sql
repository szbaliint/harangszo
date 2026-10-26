-- Migration 006: seasonal date ranges, "nth weekday of the month" rules, and tools to fix duplicate churches.
-- Run once in the Supabase SQL Editor (after 005). Safe to re-run. A fresh install only needs schema.sql.

alter table public.services add column if not exists valid text;        -- "MM-DD/MM-DD[,…]": only on these days of the year
alter table public.services add column if not exists weeks smallint[];   -- weeks of the month: 1..5, -1 = last ("utolsó szombat")
alter table public.services drop constraint if exists services_valid_check;
alter table public.services add constraint services_valid_check check (valid is null or valid ~ '^\d\d-\d\d/\d\d-\d\d(,\d\d-\d\d/\d\d-\d\d)*$');
alter table public.services drop constraint if exists services_weeks_check;
alter table public.services add constraint services_weeks_check check (weeks is null or (weeks <@ array[-1,1,2,3,4,5]::smallint[] and cardinality(weeks) > 0));
alter table public.services drop constraint if exists services_period_check;
alter table public.services add constraint services_period_check check (period in ('all','summer','winter','autumn','spring'));
alter table public.churches add column if not exists created_by text;                      -- e.g. 'szfvar' when an import added the church
alter table public.churches add column if not exists match_confirmed boolean not null default false;  -- an editor confirmed the import's match
create index if not exists churches_lat_idx on public.churches (lat);
update public.churches set created_by = schedule_source
 where created_by is null and osm_id is null and schedule_source is not null and notes like 'Importálva:%';

-- Import jobs (secret key only): the import now points this source entry at another church. Remove what the import
-- put on the old one. A church the import itself created, and that nobody touched, is deleted.
create or replace function public.release_imported_church(cid bigint, src text) returns text
language plpgsql security invoker set search_path = public as $$
declare c churches%rowtype;
begin
  select * into c from churches where id = cid;
  if not found then return 'missing'; end if;
  if c.schedule_locked or c.match_confirmed then return 'kept'; end if;
  if c.created_by = src and not exists (select 1 from events where church_id = cid)
     and not exists (select 1 from suggestions where church_id = cid) and not exists (select 1 from opening_hours where church_id = cid)
     and not exists (select 1 from staff_churches where church_id = cid) then
    delete from churches where id = cid; return 'deleted';
  end if;
  if c.schedule_source = src then
    delete from services where church_id = cid;
    update churches set schedule_source = null, schedule_source_url = null, schedule_updated = null, schedule_note = null, source_ref = null where id = cid;
    return 'cleared';
  end if;
  return 'kept';
end $$;
revoke execute on function public.release_imported_church(bigint, text) from public, anon, authenticated;
grant execute on function public.release_imported_church(bigint, text) to service_role;

-- Merge a duplicate (drop) into the church to keep. The kept church keeps its place; its times come from
-- `schedule_from` ('keep' or 'drop'). Events, suggestions and parish editors move over; empty fields are filled in.
-- Admins only (or import jobs with the secret key).
create or replace function public.merge_churches(keep_id bigint, drop_id bigint, schedule_from text default 'auto', name_from text default 'keep') returns bigint
language plpgsql security invoker set search_path = public as $$
declare k churches%rowtype; d churches%rowtype; take_drop boolean;
begin
  if keep_id = drop_id then raise exception 'A két templom ugyanaz.'; end if;
  if current_user <> 'service_role' and not public.is_admin() then raise exception 'Összevonni csak adminisztrátor tud.'; end if;
  select * into k from churches where id = keep_id; if not found then raise exception 'Nincs ilyen templom: %', keep_id; end if;
  select * into d from churches where id = drop_id; if not found then raise exception 'Nincs ilyen templom: %', drop_id; end if;
  take_drop := case schedule_from when 'drop' then true when 'keep' then false
                 else not exists (select 1 from services where church_id = keep_id) and exists (select 1 from services where church_id = drop_id) end;
  if take_drop then
    delete from services where church_id = keep_id;
    update services set church_id = keep_id where church_id = drop_id;
    if not exists (select 1 from opening_hours where church_id = keep_id) then update opening_hours set church_id = keep_id where church_id = drop_id; end if;
    update churches set schedule_note = d.schedule_note, schedule_source = d.schedule_source, schedule_source_url = d.schedule_source_url,
           schedule_updated = d.schedule_updated, feast_sunday = d.feast_sunday, open_only_services = d.open_only_services where id = keep_id;
  else
    if not exists (select 1 from opening_hours where church_id = keep_id) then update opening_hours set church_id = keep_id where church_id = drop_id; end if;
  end if;
  update events set church_id = keep_id where church_id = drop_id;
  update suggestions set church_id = keep_id where church_id = drop_id;
  insert into staff_churches (user_id, church_id) select user_id, keep_id from staff_churches where church_id = drop_id on conflict do nothing;
  delete from churches where id = drop_id;   -- frees drop's source_ref before it is moved over
  update churches set
    name = case when name_from = 'drop' then d.name else k.name end,
    city = case when coalesce(k.city,'') = '' then d.city else k.city end,
    address = case when coalesce(k.address,'') = '' then d.address else k.address end,
    website = coalesce(k.website, d.website), phone = coalesce(k.phone, d.phone),
    notes = nullif(concat_ws(E'\n', k.notes, d.notes), ''),
    source_ref = coalesce(case when take_drop then d.source_ref end, k.source_ref, d.source_ref),
    schedule_source = case when take_drop then d.schedule_source else coalesce(k.schedule_source, case when d.source_ref is not null then d.schedule_source end) end,
    importance_auto = greatest(k.importance_auto, d.importance_auto),
    importance_manual = coalesce(k.importance_manual, d.importance_manual),
    location_approx = k.location_approx and d.location_approx,
    match_confirmed = (d.source_ref is not null or k.source_ref is not null),
    schedule_locked = k.schedule_locked or d.schedule_locked
  where id = keep_id;
  return keep_id;
end $$;
revoke execute on function public.merge_churches(bigint, bigint, text, text) from public, anon;
grant execute on function public.merge_churches(bigint, bigint, text, text) to authenticated, service_role;

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
  insert into services (church_id, kind, days, start_time, end_time, note, period, feast, valid, weeks)
    select cid, x->>'kind', array(select jsonb_array_elements_text(coalesce(x->'days','[]'::jsonb))::smallint),
           (x->>'start')::time, nullif(x->>'end','')::time, nullif(x->>'note',''),
           coalesce(nullif(x->>'period',''),'all'), nullif(x->>'feast',''), nullif(x->>'valid',''),
           case when jsonb_typeof(x->'weeks') = 'array' and jsonb_array_length(x->'weeks') > 0
                then array(select jsonb_array_elements_text(x->'weeks')::smallint) end
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
                   'end', to_char(s.end_time,'HH24:MI'), 'note', s.note, 'period', nullif(s.period,'all'), 'feast', s.feast, 'valid', s.valid, 'weeks', s.weeks)) order by s.start_time)
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
  insert into services (church_id, kind, days, start_time, end_time, note, period, feast, valid, weeks)
    select cid, x->>'kind', array(select jsonb_array_elements_text(coalesce(x->'days','[]'::jsonb))::smallint),
           (x->>'start')::time, nullif(x->>'end','')::time, nullif(x->>'note',''),
           coalesce(nullif(x->>'period',''),'all'), nullif(x->>'feast',''), nullif(x->>'valid',''),
           case when jsonb_typeof(x->'weeks') = 'array' and jsonb_array_length(x->'weeks') > 0
                then array(select jsonb_array_elements_text(x->'weeks')::smallint) end
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
  c.id, c.name, c.city, c.address, c.rite, c.published, c.updated_at, c.lat, c.lon, c.created_by,
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
  (select count(*) from public.suggestions g where g.church_id = c.id and g.status = 'pending')::int as n_pending,
  -- another church within about 130 m: possibly the same building entered twice
  exists (select 1 from public.churches o where o.id <> c.id and o.lat between c.lat - 0.0012 and c.lat + 0.0012
                                          and o.lon between c.lon - 0.0018 and c.lon + 0.0018) as near_duplicate
from public.churches c;

revoke all on public.admin_church_list from anon;
grant select on public.admin_church_list to authenticated;
