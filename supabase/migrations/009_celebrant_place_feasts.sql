-- 009: who celebrates, where, on feast days or not, and more seasons.
--  * celebrant: who says the Mass ("P. Kamill", "Spányi Antal megyéspüspök", "görögkatolikus pap", "diakónus")
--  * place / place_church_id: held somewhere else than the church itself (a chapel, the cemetery, a hospital,
--    another church). With place_church_id the time also shows on that church on the map.
--  * feast_skip: this regular time does not happen on holy days of obligation and public holidays
--  * feast keys 'holyday' (every holy day of obligation) and 'public' (every public holiday) for one rule that
--    covers them all; feast_sunday may also hold them ("munkaszüneti napokon vasárnapi rend")
--  * periods: summer/winter still follow the clock change (nyári / téli időszámítás); new: summer_months (jún–aug),
--    winter_months (dec–feb), christmas (karácsonyi idő: dec. 25 – Urunk megkeresztelkedése)
--  * tag 'solemn': ünnepi szentmise / nagymise
-- Needs 007 and 008 first. Safe to run twice.

alter table public.services
  add column if not exists celebrant text,
  add column if not exists place text,
  add column if not exists place_church_id bigint references public.churches(id) on delete set null,
  add column if not exists feast_skip boolean not null default false;
alter table public.dated_services
  add column if not exists celebrant text,
  add column if not exists place text,
  add column if not exists place_church_id bigint references public.churches(id) on delete set null;
create index if not exists services_place_church_idx on public.services (place_church_id) where place_church_id is not null;

alter table public.services drop constraint if exists services_period_check, drop constraint if exists services_tags_check,
  drop constraint if exists services_celebrant_check, drop constraint if exists services_place_check;
alter table public.services
  add constraint services_period_check check (period in ('all','summer','winter','summer_months','winter_months','autumn','spring','advent','christmas','lent','eastertide','school','holiday')),
  add constraint services_tags_check check (tags is null or array_to_string(tags, ' ') ~ '^((lang:[a-z]{2,3}|family|student|youth|university|guitar|organ|choir|silent|vigil|word|confession|traditional|irregular|solemn)( |$))+$'),
  add constraint services_celebrant_check check (celebrant is null or char_length(celebrant) between 1 and 80),
  add constraint services_place_check check ((place is null or char_length(place) between 1 and 120) and (place_church_id is null or place_church_id <> church_id));
alter table public.dated_services drop constraint if exists dated_services_tags_check, drop constraint if exists dated_services_celebrant_check, drop constraint if exists dated_services_place_check;
alter table public.dated_services
  add constraint dated_services_tags_check check (tags is null or array_to_string(tags, ' ') ~ '^((lang:[a-z]{2,3}|family|student|youth|university|guitar|organ|choir|silent|vigil|word|confession|traditional|irregular|solemn)( |$))+$'),
  add constraint dated_services_celebrant_check check (celebrant is null or char_length(celebrant) between 1 and 80),
  add constraint dated_services_place_check check ((place is null or char_length(place) between 1 and 120) and (place_church_id is null or place_church_id <> church_id));

-- Inserts schedule rows given as JSON (used by save_church and import_church_schedule). Runs with the caller's rights.
create or replace function public.insert_services(cid bigint, rows jsonb) returns void
language sql security invoker set search_path = public as $$
  insert into services (church_id, kind, days, start_time, end_time, note, period, feast, valid, weeks, every, anchor, tags, celebrant, place, place_church_id, feast_skip)
    select cid, x->>'kind', array(select jsonb_array_elements_text(coalesce(x->'days','[]'::jsonb))::smallint),
           (x->>'start')::time, nullif(x->>'end','')::time, nullif(x->>'note',''),
           coalesce(nullif(x->>'period',''),'all'), nullif(x->>'feast',''), nullif(x->>'valid',''),
           case when jsonb_typeof(x->'weeks') = 'array' and jsonb_array_length(x->'weeks') > 0
                then array(select jsonb_array_elements_text(x->'weeks')::smallint) end,
           case when coalesce((x->>'every')::int, 1) >= 2 and nullif(x->>'anchor','') is not null then (x->>'every')::smallint end,
           case when coalesce((x->>'every')::int, 1) >= 2 then nullif(x->>'anchor','')::date end,
           case when jsonb_typeof(x->'tags') = 'array' and jsonb_array_length(x->'tags') > 0
                then array(select distinct jsonb_array_elements_text(x->'tags')) end,
           nullif(btrim(x->>'celebrant'),''), nullif(btrim(x->>'place'),''),
           nullif(nullif(x->>'place_church_id','')::bigint, cid), coalesce((x->>'feast_skip')::boolean, false)
    from jsonb_array_elements(coalesce(rows,'[]'::jsonb)) x;
$$;
revoke execute on function public.insert_services(bigint, jsonb) from public, anon;
grant execute on function public.insert_services(bigint, jsonb) to authenticated, service_role;

-- Used by import jobs (secret key only): replaces one source's rows for a church between two dates.
create or replace function public.import_dated_services(p jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare cid bigint := (p->>'church_id')::bigint; src text := p->>'source'; n integer;
begin
  delete from dated_services where church_id = cid and source = src and date between (p->>'from')::date and (p->>'to')::date;
  insert into dated_services (church_id, date, kind, start_time, end_time, note, tags, celebrant, place, place_church_id, source, source_url)
    select cid, (x->>'date')::date, x->>'kind', (x->>'start')::time, nullif(x->>'end','')::time, nullif(x->>'note',''),
           case when jsonb_typeof(x->'tags') = 'array' and jsonb_array_length(x->'tags') > 0 then array(select distinct jsonb_array_elements_text(x->'tags')) end,
           left(nullif(btrim(x->>'celebrant'),''), 80), left(nullif(btrim(x->>'place'),''), 120), nullif(nullif(x->>'place_church_id','')::bigint, cid),
           src, nullif(p->>'source_url','')
    from jsonb_array_elements(coalesce(p->'rows','[]'::jsonb)) x;
  get diagnostics n = row_count;
  -- Old weeks are not needed any more.
  delete from dated_services where church_id = cid and source = src and date < current_date - 7;
  return n;
end $$;
revoke execute on function public.import_dated_services(jsonb) from public, anon, authenticated;
grant execute on function public.import_dated_services(jsonb) to service_role;

create or replace function public.merge_churches(keep_id bigint, drop_id bigint, schedule_from text default 'auto', name_from text default 'keep') returns bigint
language plpgsql security invoker set search_path = public as $$
declare k churches%rowtype; d churches%rowtype; take_drop boolean;
begin
  if keep_id = drop_id then raise exception 'A két templom ugyanaz.'; end if;
  if current_user <> 'service_role' and not public.is_admin() then raise exception 'Összevonni csak adminisztrátor tud.'; end if;
  select * into k from churches where id = keep_id; if not found then raise exception 'Nincs ilyen templom: %', keep_id; end if;
  select * into d from churches where id = drop_id; if not found then raise exception 'Nincs ilyen templom: %', drop_id; end if;
  -- Times one of the two holds at the other become times at home (with the place's name kept as text).
  update services set place = coalesce(place, case when place_church_id = keep_id then k.name else d.name end), place_church_id = null
    where (church_id = drop_id and place_church_id = keep_id) or (church_id = keep_id and place_church_id = drop_id);
  update dated_services set place = coalesce(place, case when place_church_id = keep_id then k.name else d.name end), place_church_id = null
    where (church_id = drop_id and place_church_id = keep_id) or (church_id = keep_id and place_church_id = drop_id);
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
  update dated_services set church_id = keep_id where church_id = drop_id;
  update services set place_church_id = keep_id where place_church_id = drop_id;
  update dated_services set place_church_id = keep_id where place_church_id = drop_id;
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
                   'every', s.every, 'anchor', s.anchor, 'tags', s.tags, 'celebrant', s.celebrant, 'place', s.place, 'place_id', s.place_church_id,
                   'skip', nullif(s.feast_skip, false))) order by s.start_time)
              from services s where s.church_id = c.id),
    'dated', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('date', d.date, 'kind', d.kind, 'start', to_char(d.start_time,'HH24:MI'),
                   'end', to_char(d.end_time,'HH24:MI'), 'note', d.note, 'tags', d.tags, 'celebrant', d.celebrant, 'place', d.place, 'place_id', d.place_church_id,
                   'url', d.source_url)) order by d.date, d.start_time)
              from dated_services d where d.church_id = c.id and d.date >= current_date - 1 and d.date <= current_date + 21),
    'events', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('date', e.date, 'start', to_char(e.start_time,'HH24:MI'), 'title', e.title, 'note', e.note)) order by e.date)
              from events e where e.church_id = c.id and e.date >= current_date - 1 and e.date <= current_date + 120)
  ))), '[]'::jsonb)
  from churches c where c.published;
$$;
grant execute on function public.public_data() to anon, authenticated;
