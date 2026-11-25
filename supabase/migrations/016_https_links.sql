-- 016: links shown on the public map from the database must be https:// (security review, 2026-11-25).
--  * dated_services.source_url ("a templom heti miserendje (PDF)", "forrás") can be written by parish editors directly;
--    a javascript: or data: URL there would reach an href. The map also checks the scheme (app.js httpsUrl).
--  * churches.schedule_source_url (set by imports and the admin) gets the same rule.
-- All rows were https:// or empty when this was written. Safe to run twice.

alter table public.dated_services drop constraint if exists dated_services_source_url_check;
alter table public.dated_services add constraint dated_services_source_url_check
  check (source_url is null or (source_url ~ '^https://[^\s]+$' and char_length(source_url) <= 1000));

alter table public.churches drop constraint if exists churches_schedule_source_url_check;
alter table public.churches add constraint churches_schedule_source_url_check
  check (schedule_source_url is null or (schedule_source_url ~ '^https://[^\s]+$' and char_length(schedule_source_url) <= 1000));
