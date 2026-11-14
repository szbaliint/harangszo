-- 014: track() also counts the map app's home tab, "Most" (the church-first redesign: Most · Térkép · Mentett).
--  * 'tab' events accept 'most' besides 'map', 'list' (the search panel) and 'saved'; everything else is as in 012.
--  * app.js counts a switch back to Most (opening the app on Most is not a switch and is not counted).
-- Needs 011 and 012 first. Safe to run twice.

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
  if random() < 0.005 then perform public.purge_old_data(); end if;
  for it in select * from jsonb_array_elements(p) loop
    cnt := cnt + 1;
    exit when cnt > 30;                       -- one call carries a handful of events, never a flood
    e := it->>'e';
    k := coalesce(it->>'k', '');
    if e in ('visit', 'visitor', 'new_visitor', 'install', 'locate') then
      k := '';
    elsif e = 'device' then continue when k not in ('phone', 'tablet', 'desktop');
    elsif e = 'mode'   then continue when k not in ('app', 'browser');
    elsif e = 'tab'    then continue when k not in ('most', 'map', 'list', 'saved');
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
