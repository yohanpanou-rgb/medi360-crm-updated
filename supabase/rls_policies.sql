-- ============================================================================
-- medi360 CRM — Row Level Security (RLS) policies
-- ============================================================================
-- WHY THIS FILE EXISTS
-- All access control in index.html (isSuperAdmin(), canSee(), per-clinic
-- scoping) is client-side JavaScript. It decides what the UI *shows*, but
-- anyone with the anon key (visible in the page source) can call the
-- Supabase REST API directly and bypass every one of those checks. The only
-- thing that actually enforces "clinic A cannot read/write clinic B's data"
-- is Postgres Row Level Security on the database itself.
--
-- Run this whole file once in the Supabase SQL editor (Dashboard > SQL
-- Editor > New query) against your project. It is written to be safely
-- re-run (DROP POLICY IF EXISTS before each CREATE POLICY), and it SKIPS
-- (with a NOTICE, not an error) any of the 8 expected tables that don't
-- actually exist in your database yet, so one missing/renamed table can't
-- abort the whole script and leave nothing applied.
--
-- ASSUMPTIONS (matching what index.html actually queries):
--   - profiles.id            = auth.users.id (one row per logged-in user)
--   - profiles.role           in ('super_admin','clinic_admin','therapist','receptionist')
--   - profiles.clinic_id      references clinics.id
--   - patients / appointments / laser_forms / pipeline_deals / sms_log /
--     service_consent_templates / gdpr_consents / laser_consents /
--     service_consents / unmatched_consultations / patient_photos all have
--     a clinic_id column (confirmed against every sb.from(...) call in the
--     live production app, including the patient-detail consent/photo loads)
--   - The 'patient-photos' Storage bucket is private, and every object path
--     is written as `${clinic_id}/${patient_id}/${filename}` (see the photo
--     upload handler in index.html) — the storage policies below rely on
--     that path convention to scope access per clinic.
--   - User creation/role changes go through a Supabase Edge Function using
--     the service_role key (per the comment already in index.html), NOT
--     directly from the browser — so profiles has no client-side
--     INSERT/UPDATE/DELETE policy below. If you don't have that Edge
--     Function yet, build it before relying on this file for user mgmt.
--
-- If a table listed below shows up as SKIPPED when you run this, check the
-- NOTICE output for the exact list of tables that really exist in your
-- project (printed first), and either rename the table to match what
-- index.html expects, or tell me the real name so I can update index.html
-- and this file to match.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. Diagnostic: list every table that actually exists in `public`
-- ----------------------------------------------------------------------------
-- This always runs and never fails — check the NOTICE output after running
-- to see what's really in your database.
do $$
declare
  r record;
  found_tables text := '';
begin
  for r in select table_name from information_schema.tables
           where table_schema='public' and table_type='BASE TABLE'
           order by table_name
  loop
    found_tables := found_tables || r.table_name || ', ';
  end loop;
  raise notice 'Tables that actually exist in public schema: %', found_tables;
end $$;


-- ----------------------------------------------------------------------------
-- 1. Helper functions
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER is required here: policies on `profiles` itself would
-- otherwise recurse into `profiles` again to check the caller's role,
-- causing "infinite recursion detected in policy" errors. A SECURITY DEFINER
-- function runs with the privileges of its owner (bypassing RLS internally),
-- so it can safely look up the caller's own row.
-- These are only created if `profiles` exists — everything downstream
-- depends on it.

do $$
begin
  if to_regclass('public.profiles') is null then
    raise notice 'SKIPPED: public.profiles does not exist — cannot create helper functions or any policy below. Fix this first.';
    return;
  end if;

  create or replace function public.current_user_role()
  returns text
  language sql
  stable
  security definer
  set search_path = public
  as $f$
    select role from public.profiles where id = auth.uid();
  $f$;

  create or replace function public.current_user_clinic_id()
  returns uuid
  language sql
  stable
  security definer
  set search_path = public
  as $f$
    select clinic_id from public.profiles where id = auth.uid();
  $f$;

  create or replace function public.is_super_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
  as $f$
    select coalesce(public.current_user_role() = 'super_admin', false);
  $f$;

  create or replace function public.is_clinic_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
  as $f$
    select coalesce(public.current_user_role() = 'clinic_admin', false);
  $f$;
end $$;


-- ----------------------------------------------------------------------------
-- 2. Enable RLS on every table the app queries (only if it exists)
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['profiles','clinics','patients','appointments','laser_forms','pipeline_deals','sms_log','service_consent_templates','gdpr_consents','laser_consents','service_consents','unmatched_consultations','patient_photos','medical_history_consents','patient_relationships','services','staff_services','staff_schedules','staff_schedule_overrides','staff_time_off','patient_packages']
  loop
    if to_regclass('public.' || t) is null then
      raise notice 'SKIPPED (table does not exist): %', t;
    else
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- 3. profiles
-- ----------------------------------------------------------------------------
-- SELECT: super_admin sees everyone; everyone else sees only profiles in
-- their own clinic (needed for the calendar's staff dropdown and the
-- Settings > Users list).
-- No INSERT/UPDATE/DELETE policy for the authenticated role on purpose —
-- user creation/role changes must go through a service_role Edge Function.

do $$
begin
  if to_regclass('public.profiles') is null then
    raise notice 'SKIPPED: public.profiles does not exist';
    return;
  end if;

  drop policy if exists "profiles_select" on public.profiles;
  create policy "profiles_select" on public.profiles
    for select
    using (
      public.is_super_admin()
      or clinic_id = public.current_user_clinic_id()
    );
end $$;


-- ----------------------------------------------------------------------------
-- 4. clinics
-- ----------------------------------------------------------------------------
-- SELECT: super_admin sees every clinic; everyone else sees only their own.
-- INSERT: super_admin only (creating a new clinic).
-- UPDATE: super_admin, or clinic_admin updating their own clinic's settings/
--         integrations (Settings page).
-- No DELETE policy — deleting a clinic is destructive and isn't exposed in
-- the app; do it manually with elevated access if ever needed.

do $$
begin
  if to_regclass('public.clinics') is null then
    raise notice 'SKIPPED: public.clinics does not exist';
    return;
  end if;

  drop policy if exists "clinics_select" on public.clinics;
  create policy "clinics_select" on public.clinics
    for select
    using (
      public.is_super_admin()
      or id = public.current_user_clinic_id()
    );

  drop policy if exists "clinics_insert" on public.clinics;
  create policy "clinics_insert" on public.clinics
    for insert
    with check (public.is_super_admin());

  drop policy if exists "clinics_update" on public.clinics;
  create policy "clinics_update" on public.clinics
    for update
    using (
      public.is_super_admin()
      or (public.is_clinic_admin() and id = public.current_user_clinic_id())
    )
    with check (
      public.is_super_admin()
      or (public.is_clinic_admin() and id = public.current_user_clinic_id())
    );
end $$;


-- ----------------------------------------------------------------------------
-- 5. Generic clinic-scoped tables (only the ones that actually exist)
-- ----------------------------------------------------------------------------
-- patients, appointments, laser_forms, pipeline_deals, sms_log,
-- service_consent_templates, gdpr_consents, laser_consents, service_consents,
-- unmatched_consultations, patient_photos: every role in a clinic can
-- read/write rows that belong to their own clinic_id (matches how the app
-- already lets therapist/receptionist/clinic_admin all create patients,
-- appointments, laser forms, consents, and patient photos). super_admin can
-- read/write across all clinics.
--
-- DELETE is intentionally restricted to clinic_admin/super_admin for most of
-- these tables: the app's UI only exposes a delete action for consent
-- templates and unmatched consultations (both from the Settings/Consents
-- pages, already role-gated to clinic_admin/super_admin by the NAV array)
-- today, and nothing in the client should ever need to delete a
-- patient/appointment/laser/consent record as a therapist/receptionist.
-- Loosen this per table if that's wrong for your workflow.
--
-- patient_photos is the one exception: index.html's patient-detail page lets
-- ANY logged-in role delete a photo (deletePatientPhoto(), no role check in
-- the UI) — so it gets its own, less restrictive delete policy below rather
-- than the clinic_admin/super_admin-only one every other table gets here.

do $$
declare
  t text;
begin
  foreach t in array array['patients','appointments','laser_forms','pipeline_deals','sms_log','service_consent_templates','gdpr_consents','laser_consents','service_consents','unmatched_consultations','patient_photos','medical_history_consents','patient_relationships','services','staff_services','staff_schedules','staff_schedule_overrides','staff_time_off','patient_packages']
  loop
    if to_regclass('public.' || t) is null then
      raise notice 'SKIPPED (table does not exist): %', t;
      continue;
    end if;

    execute format('drop policy if exists "%s_select" on public.%I', t, t);
    execute format($f$
      create policy "%s_select" on public.%I
        for select
        using (
          public.is_super_admin()
          or clinic_id = public.current_user_clinic_id()
        );
    $f$, t, t);

    execute format('drop policy if exists "%s_insert" on public.%I', t, t);
    execute format($f$
      create policy "%s_insert" on public.%I
        for insert
        with check (
          public.is_super_admin()
          or clinic_id = public.current_user_clinic_id()
        );
    $f$, t, t);

    execute format('drop policy if exists "%s_update" on public.%I', t, t);
    execute format($f$
      create policy "%s_update" on public.%I
        for update
        using (
          public.is_super_admin()
          or clinic_id = public.current_user_clinic_id()
        )
        with check (
          public.is_super_admin()
          or clinic_id = public.current_user_clinic_id()
        );
    $f$, t, t);

    if t = 'patient_photos' or t = 'patient_relationships' then
      -- Broader delete: any clinic member can remove a photo or a patient
      -- relationship link, matching the app's unrestricted delete actions
      -- for both (deletePatientPhoto() and the Συσχετισμοί card's remove
      -- button — low-stakes data, no reason to require clinic_admin).
      execute format('drop policy if exists "%s_delete" on public.%I', t, t);
      execute format($f$
        create policy "%s_delete" on public.%I
          for delete
          using (
            public.is_super_admin()
            or clinic_id = public.current_user_clinic_id()
          );
      $f$, t, t);
      continue;
    end if;

    execute format('drop policy if exists "%s_delete" on public.%I', t, t);
    execute format($f$
      create policy "%s_delete" on public.%I
        for delete
        using (
          public.is_super_admin()
          or (public.is_clinic_admin() and clinic_id = public.current_user_clinic_id())
        );
    $f$, t, t);
  end loop;
end $$;


-- ----------------------------------------------------------------------------
-- 5b. Storage: 'patient-photos' bucket
-- ----------------------------------------------------------------------------
-- Object paths are written by index.html as `${clinic_id}/${patient_id}/${filename}`
-- (see the photo upload handler), so the clinic_id is the first path segment.
-- storage.foldername(name) returns that path split into an array of segments.

do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'SKIPPED: storage.objects does not exist (Storage not enabled?)';
    return;
  end if;

  drop policy if exists "patient_photos_storage_select" on storage.objects;
  create policy "patient_photos_storage_select" on storage.objects
    for select
    using (
      bucket_id = 'patient-photos'
      and (
        public.is_super_admin()
        or (storage.foldername(name))[1] = public.current_user_clinic_id()::text
      )
    );

  drop policy if exists "patient_photos_storage_insert" on storage.objects;
  create policy "patient_photos_storage_insert" on storage.objects
    for insert
    with check (
      bucket_id = 'patient-photos'
      and (
        public.is_super_admin()
        or (storage.foldername(name))[1] = public.current_user_clinic_id()::text
      )
    );

  drop policy if exists "patient_photos_storage_delete" on storage.objects;
  create policy "patient_photos_storage_delete" on storage.objects
    for delete
    using (
      bucket_id = 'patient-photos'
      and (
        public.is_super_admin()
        or (storage.foldername(name))[1] = public.current_user_clinic_id()::text
      )
    );
end $$;


-- ============================================================================
-- 6. VERIFICATION CHECKLIST — run these after applying the policies above
-- ============================================================================
-- RLS is easy to get "technically on" but still leaky. Actually test it:
--
-- [ ] Check the NOTICE output from this run (Supabase SQL editor shows it
--     below the results, or in "Logs") for any "SKIPPED" lines — those
--     tables got NO policies at all and are either missing or misnamed.
--
-- [ ] Confirm RLS is enabled on every table that exists:
--       select relname, relrowsecurity from pg_class
--       where relname in ('profiles','clinics','patients','appointments',
--                         'laser_forms','pipeline_deals','sms_log',
--                         'service_consent_templates','gdpr_consents',
--                         'laser_consents','service_consents',
--                         'unmatched_consultations','patient_photos');
--     relrowsecurity must be `t` for every row returned.
--
-- [ ] Confirm the anon key alone (no session) gets ZERO rows back:
--       Using curl/Postman with only the anon apikey header (no user JWT),
--       GET .../rest/v1/patients?select=* should return [] , not real data.
--
-- [ ] If the 'patient-photos' Storage bucket exists, confirm it's marked
--     private (not public) in Storage settings — the storage.objects
--     policies above only matter if the bucket itself isn't public, since a
--     public bucket serves objects over a direct URL with no auth check at
--     all, bypassing RLS entirely.
--
-- [ ] Cross-clinic isolation test (do this with two real test accounts):
--       1. Log in as a clinic_admin/therapist/receptionist of Clinic A.
--       2. Note a patient/appointment id that belongs to Clinic B.
--       3. Try GET .../rest/v1/patients?id=eq.<clinic_B_patient_id> using
--          Clinic A's session JWT. Expected: empty result, not the record.
--       4. Try to PATCH/DELETE that same Clinic B row as Clinic A. Expected:
--          0 rows affected / permission-denied-shaped response, not success.
--
-- [ ] super_admin sanity check: confirm a super_admin account can still see
--     and edit every clinic's data (the policies above should already allow
--     this via is_super_admin(), but verify after applying).
--
-- [ ] Re-test the app's normal flows end-to-end after applying (patients
--     list, appointments, calendar staff dropdown, laser forms, pipeline,
--     SMS log, consents, Settings > clinic integrations) to make sure
--     nothing that used to work is now silently blocked by RLS.
--
-- [ ] If user creation isn't already wired through a service_role Edge
--     Function, build that next — profiles has no INSERT policy here on
--     purpose, so client-side user creation will fail until that exists.
-- ============================================================================
