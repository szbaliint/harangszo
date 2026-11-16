-- 015: a church's own feast days (its búcsú, its patron saint's day), each on a fixed date every year.
--  * churches.own_feasts = [{"key": "own_1", "name": "Szent Anna búcsú", "md": "07-26"}, …]: at most 10, key own_<1–999>
--    (unique per church), name 1–80 characters with no surrounding spaces, md a real calendar day (02-29 allowed: it is
--    held in leap years only). The check constraint (own_feasts_ok) holds for every write, direct updates included.
--  * An own feast's key works like a built-in feast's key (calendar.js FEASTS): in churches.feast_sunday the Sunday order
--    applies on its day, or services rows with feast = key give its own times. On its day it comes before the built-in feasts.
--  * save_church() takes p.own_feasts (names are trimmed; a payload without the key leaves the church's own feasts as they
--    are) and drops services rows and feast_sunday entries of own feasts the church no longer has.
--    Parish editors may change own_feasts (it is not an admin-only field; churches_guard leaves it alone).
--  * public_data() returns own_feasts when the church has any.
--  * merge_churches(): own feasts go with the times that are kept; when that church has none, the other church's own
--    feasts come over with their times and Sunday-order setting.
--  * admin_church_list.has_feast also counts own feasts.
--  * import_church_schedule() is unchanged: it deletes only regular rows and the feast keys its payload brings, and the
--    imports never send own_* keys, so own-feast rows stay.
-- Needs 013 first. Safe to run twice.

create or replace function public.own_feasts_ok(v jsonb) returns boolean
language plpgsql immutable set search_path = public as $$
declare x jsonb; seen text[] := '{}';
begin
  if v is null or jsonb_typeof(v) <> 'array' then return false; end if;
  if jsonb_array_length(v) > 10 then return false; end if;
  for x in select * from jsonb_array_elements(v) loop
    if jsonb_typeof(x) <> 'object' then return false; end if;
    if (select array_agg(k order by k) from jsonb_object_keys(x) k) is distinct from array['key','md','name'] then return false; end if;
    if jsonb_typeof(x->'key') <> 'string' or jsonb_typeof(x->'name') <> 'string' or jsonb_typeof(x->'md') <> 'string' then return false; end if;
    if x->>'key' !~ '^own_[0-9]{1,3}$' or x->>'key' = any(seen) then return false; end if;
    if char_length(x->>'name') not between 1 and 80 or x->>'name' <> btrim(x->>'name') or x->>'name' ~ '[[:cntrl:]]' then return false; end if;
    if x->>'md' !~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then return false; end if;
    if substr(x->>'md', 4, 2)::int > (array[31,29,31,30,31,30,31,31,30,31,30,31])[substr(x->>'md', 1, 2)::int] then return false; end if;
    seen := seen || (x->>'key');
  end loop;
  return true;
end $$;

alter table public.churches add column if not exists own_feasts jsonb not null default '[]'::jsonb;
alter table public.churches drop constraint if exists churches_own_feasts_check;
alter table public.churches add constraint churches_own_feasts_check check (public.own_feasts_ok(own_feasts));

create or replace function public.save_church(p jsonb) returns bigint
language plpgsql security invoker set search_path = public as $$
declare cid bigint := nullif(p->>'id','')::bigint;
        fs text[] := array(select jsonb_array_elements_text(coalesce(p->'feast_sunday','[]'::jsonb)));
        imp smallint := nullif(p->>'importance_manual','')::smallint;
        snote text := nullif(p->>'schedule_note','');
        approx boolean := coalesce((p->>'location_approx')::boolean, false);
        locked boolean := coalesce((p->>'schedule_locked')::boolean, false);
        admin boolean := public.is_admin();
        -- The church's own feasts as sent (names trimmed); null = not sent, keep them as they are.
        own jsonb := case when jsonb_typeof(p->'own_feasts') is null or jsonb_typeof(p->'own_feasts') = 'null' then null
                          when jsonb_typeof(p->'own_feasts') <> 'array' then p->'own_feasts'   -- left to the check constraint
                          else coalesce((select jsonb_agg(case when jsonb_typeof(x) = 'object' then jsonb_build_object('key', x->'key', 'name', to_jsonb(btrim(x->>'name')), 'md', x->'md') else x end order by n)
                                         from jsonb_array_elements(p->'own_feasts') with ordinality t(x, n)), '[]'::jsonb) end;
        own_keys text[];
begin
  if cid is null then
    insert into churches (name, city, address, rite, lat, lon, website, phone, notes, open_only_services, published, feast_sunday, importance_manual, importance_auto, schedule_note, location_approx, schedule_locked, own_feasts)
    values (p->>'name', coalesce(p->>'city',''), coalesce(p->>'address',''), coalesce(p->>'rite','rk'),
            (p->>'lat')::float8, (p->>'lon')::float8, nullif(p->>'website',''), nullif(p->>'phone',''), nullif(p->>'notes',''),
            coalesce((p->>'open_only_services')::boolean, false), coalesce((p->>'published')::boolean, true), fs, imp, 50, snote, approx, locked,
            coalesce(own, '[]'::jsonb))
    returning id into cid;
  else
    update churches set
      name = p->>'name', city = coalesce(p->>'city',''), address = coalesce(p->>'address',''),
      rite = coalesce(p->>'rite','rk'), lat = (p->>'lat')::float8, lon = (p->>'lon')::float8,
      website = nullif(p->>'website',''), phone = nullif(p->>'phone',''), notes = nullif(p->>'notes',''),
      open_only_services = coalesce((p->>'open_only_services')::boolean, false),
      published = coalesce((p->>'published')::boolean, true), feast_sunday = fs, importance_manual = imp,
      schedule_note = snote, location_approx = approx, own_feasts = coalesce(own, own_feasts),
      -- What a parish enters is never overwritten by an import.
      schedule_locked = case when admin then locked else true end
    where id = cid;
    if not found then raise exception 'Nincs ilyen templom, vagy nincs jogod szerkeszteni (id %)', cid; end if;
  end if;
  delete from opening_hours where church_id = cid;
  insert into opening_hours (church_id, days, opens, closes)
    select cid, array(select jsonb_array_elements_text(x->'days')::smallint), (x->>'opens')::time, (x->>'closes')::time
    from jsonb_array_elements(coalesce(p->'hours','[]'::jsonb)) x;
  delete from services where church_id = cid;
  perform public.insert_services(cid, p->'services');
  -- Times and the Sunday-order setting of an own feast the church no longer has go with it.
  own_keys := array(select o->>'key' from churches c, jsonb_array_elements(c.own_feasts) o where c.id = cid);
  delete from services where church_id = cid and feast ~ '^own_' and not (feast = any(own_keys));
  update churches set feast_sunday = array(select k from unnest(feast_sunday) k where k !~ '^own_' or k = any(own_keys))
    where id = cid and exists (select 1 from unnest(feast_sunday) k where k ~ '^own_' and not (k = any(own_keys)));
  delete from events where church_id = cid;
  insert into events (church_id, date, start_time, title, note)
    select cid, (x->>'date')::date, nullif(x->>'start','')::time, x->>'title', nullif(x->>'note','')
    from jsonb_array_elements(coalesce(p->'events','[]'::jsonb)) x;
  insert into church_edits (church_id, user_id, who)
    values (cid, auth.uid(), (select coalesce(display_name, email) from staff where user_id = auth.uid()));
  return cid;
end $$;
grant execute on function public.save_church(jsonb) to authenticated;

create or replace function public.public_data() returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', c.id, 'name', c.name, 'city', c.city, 'address', c.address, 'rite', c.rite,
    'lat', round(c.lat::numeric, 5), 'lon', round(c.lon::numeric, 5), 'website', c.website, 'phone', c.phone,
    'imp', coalesce(c.importance_manual, c.importance_auto),
    'open_only_services', nullif(c.open_only_services, false),
    'schedule_note', c.schedule_note, 'schedule_source', c.schedule_source, 'schedule_source_url', c.schedule_source_url,
    'schedule_updated', c.schedule_updated, 'parish_updated', c.parish_updated_at::date,
    'location_approx', nullif(c.location_approx, false), 'feast_sunday', nullif(c.feast_sunday, '{}'),
    'own_feasts', nullif(c.own_feasts, '[]'::jsonb),
    'photo_url', c.photo_url, 'photo_credit', c.photo_credit, 'photo_page', c.photo_page,
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
  -- Own feasts go with the times that are kept; when that church has none, the other one's come over with their times.
  if take_drop then
    delete from services where church_id = keep_id and not (d.own_feasts = '[]'::jsonb and coalesce(feast ~ '^own_', false));
    update services set church_id = keep_id where church_id = drop_id;
    if not exists (select 1 from opening_hours where church_id = keep_id) then update opening_hours set church_id = keep_id where church_id = drop_id; end if;
    update churches set schedule_note = d.schedule_note, schedule_source = d.schedule_source, schedule_source_url = d.schedule_source_url,
           schedule_updated = d.schedule_updated, open_only_services = d.open_only_services,
           feast_sunday = d.feast_sunday || case when d.own_feasts = '[]'::jsonb then array(select x from unnest(k.feast_sunday) x where x ~ '^own_') else '{}' end,
           own_feasts = case when d.own_feasts = '[]'::jsonb then k.own_feasts else d.own_feasts end where id = keep_id;
  else
    if not exists (select 1 from opening_hours where church_id = keep_id) then update opening_hours set church_id = keep_id where church_id = drop_id; end if;
    if k.own_feasts = '[]'::jsonb and d.own_feasts <> '[]'::jsonb then
      update services set church_id = keep_id where church_id = drop_id and feast ~ '^own_';
      update churches set own_feasts = d.own_feasts, feast_sunday = feast_sunday || array(select x from unnest(d.feast_sunday) x where x ~ '^own_') where id = keep_id;
    end if;
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
  (cardinality(c.feast_sunday) > 0 or c.own_feasts <> '[]'::jsonb or exists (select 1 from public.services s where s.church_id = c.id and s.feast is not null)) as has_feast,
  (c.open_only_services or exists (select 1 from public.opening_hours h where h.church_id = c.id)) as has_hours,
  (select count(*) from public.events e where e.church_id = c.id and e.date >= current_date)::int as n_events,
  (select count(*) from public.suggestions g where g.church_id = c.id and g.status = 'pending')::int as n_pending,
  -- another church within about 130 m: possibly the same building entered twice
  exists (select 1 from public.churches o where o.id <> c.id and o.lat between c.lat - 0.0012 and c.lat + 0.0012
                                          and o.lon between c.lon - 0.0018 and c.lon + 0.0018) as near_duplicate
from public.churches c;
revoke all on public.admin_church_list from anon;
grant select on public.admin_church_list to authenticated;
