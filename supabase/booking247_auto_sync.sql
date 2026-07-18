-- ============================================================================
-- Booking247 auto-sync — one-time setup SQL
-- ============================================================================
-- Run this ONCE in the Supabase SQL Editor (Dashboard > SQL Editor > New
-- query), AFTER you have:
--   1. Deployed the sync-booking247 Edge Function
--      (supabase functions deploy sync-booking247 --no-verify-jwt)
--   2. Set a CRON_SECRET function secret (any random string — this stops
--      random internet requests from triggering your sync):
--      supabase secrets set CRON_SECRET=<pick-any-random-string>
--   3. Set up the Google Apps Script (google-apps-script/booking247-sync.gs)
--      and saved its Sheet ID into Ρυθμίσεις → Συνδέσεις → Booking247 for
--      the clinic(s) that need it.
--
-- Replace the two placeholders below (PROJECT_REF and CRON_SECRET_VALUE)
-- with your real project ref and the same random string you used in step 2,
-- then run the whole file.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Tracking table — remembers how many Sheet rows have already been synced
--    per clinic, so the function only processes NEW rows each run instead of
--    re-scanning everything every minute.
-- ----------------------------------------------------------------------------
create table if not exists public.booking247_sync_state (
  clinic_id uuid primary key references public.clinics(id) on delete cascade,
  rows_synced integer not null default 0,
  last_synced_at timestamptz
);

alter table public.booking247_sync_state enable row level security;
-- Intentionally NO policies here. This table is bookkeeping for the
-- sync-booking247 Edge Function only, which uses the service_role key and
-- therefore bypasses RLS entirely. No anon/authenticated client should ever
-- need to read or write these rows directly.


-- ----------------------------------------------------------------------------
-- 2. Enable the extensions needed to call an Edge Function on a schedule.
-- ----------------------------------------------------------------------------
-- If these two lines fail with a permissions error, enable both extensions
-- instead via Dashboard → Database → Extensions (toggle "pg_cron" and
-- "pg_net" on), then re-run just section 3 below.
create extension if not exists pg_cron;
create extension if not exists pg_net;


-- ----------------------------------------------------------------------------
-- 3. Schedule sync-booking247 to run every minute.
-- ----------------------------------------------------------------------------
-- Replace PROJECT_REF with your Supabase project ref (the subdomain in your
-- project URL, e.g. kfidxwqgsaisbdgucsok) and CRON_SECRET_VALUE with the
-- exact same random string you set with `supabase secrets set CRON_SECRET=...`
select cron.schedule(
  'sync-booking247-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/sync-booking247',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'CRON_SECRET_VALUE'
    ),
    body := '{}'::jsonb
  );
  $$
);


-- ============================================================================
-- 4. VERIFICATION
-- ============================================================================
-- [ ] Confirm the job was created:
--       select jobid, jobname, schedule, active from cron.job where jobname = 'sync-booking247-every-minute';
--
-- [ ] After a minute or two, check it actually ran and what it returned:
--       select * from cron.job_run_details
--       where jobid = (select jobid from cron.job where jobname = 'sync-booking247-every-minute')
--       order by start_time desc limit 5;
--
-- [ ] Confirm rows are being tracked per clinic:
--       select * from public.booking247_sync_state;
--
-- To pause the auto-sync later without deleting anything:
--   select cron.unschedule('sync-booking247-every-minute');
-- To resume, just re-run section 3 above.
-- ============================================================================
