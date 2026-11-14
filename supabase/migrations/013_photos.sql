-- 013: church photos.
--  * churches.photo_url / photo_credit / photo_source ('commons' | 'parish') / photo_page / photo_checked_at.
--  * public_data() also returns photo_url, photo_credit and photo_page (the Commons file page; parish photos have none).
--  * Wikimedia Commons photos come from scripts/import-photos.mjs (secret key, import_church_photos()) or an admin;
--    a parish editor may only put its own uploaded photo on its own churches (photo_source 'parish'), or remove it.
--    churches_guard enforces this for direct updates, set_church_photo() is the parish portal's way to do it.
--  * Storage bucket 'church-photos' (public read). Editors upload to '<church_id>/<file>' for churches they may edit.
--  * A photo check by the import that changes nothing does not count as an edit (updated_at stays).
-- Needs 010 first. Safe to run twice.

alter table public.churches
  add column if not exists photo_url        text,
  add column if not exists photo_credit     text,
  add column if not exists photo_source     text,
  add column if not exists photo_page       text,
  add column if not exists photo_checked_at timestamptz;
alter table public.churches drop constraint if exists churches_photo_check;
alter table public.churches add constraint churches_photo_check check (
  (photo_source is null or photo_source in ('commons','parish'))
  and (photo_url is null or char_length(photo_url) <= 1000)
  and (photo_credit is null or char_length(photo_credit) <= 400)
  and (photo_page is null or char_length(photo_page) <= 1000));

-- Where a parish's own photo of church <cid> lives: the bucket's public URL, folder <cid>, one file name.
create or replace function public.church_photo_prefix(cid bigint) returns text
language sql immutable set search_path = public as $$
  select 'https://rlvcwytbengldqgemliu.supabase.co/storage/v1/object/public/church-photos/' || cid || '/';
$$;
create or replace function public.is_church_photo_url(cid bigint, url text) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(cid is not null and url is not null
    and left(url, char_length(public.church_photo_prefix(cid))) = public.church_photo_prefix(cid)
    and substr(url, char_length(public.church_photo_prefix(cid)) + 1) ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,120}(\?[A-Za-z0-9=&._-]{0,60})?$', false);
$$;

-- A photo check that changed nothing else (the photo import) is not an edit: updated_at stays.
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'churches' and to_jsonb(new) ->> 'photo_checked_at' is distinct from to_jsonb(old) ->> 'photo_checked_at'
     and to_jsonb(new) - 'photo_checked_at' - 'updated_at' = to_jsonb(old) - 'photo_checked_at' - 'updated_at' then
    return new;
  end if;
  new.updated_at := now(); return new;
end $$;

-- A parish editor cannot change admin-only fields; their edits are stamped. Photos: only their own uploaded photo.
create or replace function public.guard_church_update() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if current_user in ('service_role','postgres','supabase_admin') or public.is_admin() then return new; end if;
  new.published := old.published; new.importance_manual := old.importance_manual; new.importance_auto := old.importance_auto;
  new.source_ref := old.source_ref; new.schedule_source := old.schedule_source; new.schedule_source_url := old.schedule_source_url;
  new.schedule_updated := old.schedule_updated; new.match_confirmed := old.match_confirmed; new.created_by := old.created_by;
  new.osm_type := old.osm_type; new.osm_id := old.osm_id;
  new.photo_checked_at := old.photo_checked_at;
  if (new.photo_url, new.photo_credit, new.photo_source, new.photo_page) is distinct from (old.photo_url, old.photo_credit, old.photo_source, old.photo_page) then
    if new.photo_url is null and old.photo_source is distinct from 'commons' then
      -- removing the parish's own photo
      new.photo_credit := null; new.photo_source := null; new.photo_page := null;
    elsif new.photo_source = 'parish' and public.is_church_photo_url(old.id, new.photo_url) then
      new.photo_credit := 'Fotó: a plébánia'; new.photo_page := null;
    else
      -- anything else (a Commons photo, a link elsewhere, removing the Commons photo) is not theirs to set
      new.photo_url := old.photo_url; new.photo_credit := old.photo_credit; new.photo_source := old.photo_source; new.photo_page := old.photo_page;
    end if;
  end if;
  new.parish_updated_at := now(); new.parish_updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists churches_guard on public.churches;
create trigger churches_guard before update on public.churches for each row execute function public.guard_church_update();

-- Parish portal: put a photo uploaded to the 'church-photos' bucket on the church, or (url null) remove the parish's photo.
create or replace function public.set_church_photo(cid bigint, url text) returns void
language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  if auth.uid() is null or not public.can_edit_church(cid) then raise exception 'Nincs jogod ennek a templomnak a fotóját módosítani (id %).', cid; end if;
  select photo_source into cur from churches where id = cid;
  if not found then raise exception 'Nincs ilyen templom: %', cid; end if;
  if url is null then
    if cur = 'commons' and not public.is_admin() then raise exception 'A Wikimedia Commons fotót nem lehet törölni, csak sajátra cserélni.'; end if;
    update churches set photo_url = null, photo_credit = null, photo_source = null, photo_page = null where id = cid;
  else
    if not public.is_church_photo_url(cid, url) then raise exception 'A fotónak a templom saját tárhelyéről kell jönnie (%…).', public.church_photo_prefix(cid); end if;
    update churches set photo_url = url, photo_credit = 'Fotó: a plébánia', photo_source = 'parish', photo_page = null where id = cid;
  end if;
end $$;
revoke execute on function public.set_church_photo(bigint, text) from public, anon;
grant execute on function public.set_church_photo(bigint, text) to authenticated;

-- Photo import (secret key only). rows: [{id, url, credit, page}]; url null = no free photo found (a Commons photo is
-- removed). Every listed church gets photo_checked_at; a church with the parish's own photo is never touched.
create or replace function public.import_church_photos(rows jsonb) returns integer
language sql security invoker set search_path = public as $$
  with x as (
    select (r->>'id')::bigint as id, nullif(r->>'url','') as url, left(nullif(r->>'credit',''), 400) as credit, left(nullif(r->>'page',''), 1000) as page
    from jsonb_array_elements(coalesce(rows,'[]'::jsonb)) r),
  u as (
    update churches c set
      photo_url = x.url,
      photo_credit = case when x.url is not null then x.credit end,
      photo_page = case when x.url is not null then x.page end,
      photo_source = case when x.url is not null then 'commons' end,
      photo_checked_at = now()
    from x
    where c.id = x.id and (c.photo_source is null or c.photo_source = 'commons')
      and (c.photo_url, c.photo_credit, c.photo_page) is distinct from (x.url, case when x.url is not null then x.credit end, case when x.url is not null then x.page end)
    returning 1),
  t as (
    update churches c set photo_checked_at = now()
    from x
    where c.id = x.id and (c.photo_source is null or c.photo_source = 'commons')
      and (c.photo_url, c.photo_credit, c.photo_page) is not distinct from (x.url, case when x.url is not null then x.credit end, case when x.url is not null then x.page end))
  select count(*)::int from u;
$$;
revoke execute on function public.import_church_photos(jsonb) from public, anon, authenticated;
grant execute on function public.import_church_photos(jsonb) to service_role;

-- ─── Public read: everything the map needs in one call ───────────────────
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

-- ─── Storage: parish photos ───────────────────────────────────────────────
-- Public bucket: anyone can load a photo by its URL. Writing (and listing) only '<church_id>/<file>' of churches
-- the signed-in user may edit.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('church-photos', 'church-photos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_edit_photo_path(path text) returns boolean
language sql stable security definer set search_path = public as $$
  select case when path ~ '^[0-9]{1,18}/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$'
              then public.can_edit_church(split_part(path, '/', 1)::bigint) else false end;
$$;
revoke execute on function public.can_edit_photo_path(text) from public, anon;
grant execute on function public.can_edit_photo_path(text) to authenticated, service_role;

drop policy if exists church_photos_read   on storage.objects;
drop policy if exists church_photos_insert on storage.objects;
drop policy if exists church_photos_update on storage.objects;
drop policy if exists church_photos_delete on storage.objects;
create policy church_photos_read   on storage.objects for select to authenticated
  using (bucket_id = 'church-photos' and public.can_edit_photo_path(name));
create policy church_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'church-photos' and public.can_edit_photo_path(name));
create policy church_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'church-photos' and public.can_edit_photo_path(name))
  with check (bucket_id = 'church-photos' and public.can_edit_photo_path(name));
create policy church_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'church-photos' and public.can_edit_photo_path(name));
