-- 🎂 Δώρο Γενεθλίων: κάθε πρωί το σύστημα βρίσκει όσους γιορτάζουν και
-- (α) στέλνει εορταστικό email με το δώρο (δωρεάν θεραπεία προσώπου — αξία ανά
--     δώρο στη στήλη gift_value, βλ. add_gift_value_to_birthday_gifts.sql
--     + 10% έκπτωση στα καλλυντικά, ισχύς 1 μήνας) σε όσους έχουν email + GDPR,
-- (β) για τους υπόλοιπους βγάζει ειδοποίηση στη γραμματεία (Dashboard) να
--     τους καλέσει. Η καρτέλα του πελάτη δείχνει το ενεργό δώρο, και όταν
-- ολοκληρωθεί το επόμενο ραντεβού του μέσα στην ισχύ, μαρκάρεται εξαργυρωμένο.
--
-- ΒΗΜΑΤΑ:
--   1. Τρέξε αυτό το αρχείο στο SQL Editor
--   2. Ξανατρέξε το rls_policies.sql (ήδη ενημερωμένο με τον πίνακα birthday_gifts)
--   3. Deploy το edge function birthday-emails (Verify JWT: OFF) και όρισε
--      το secret BIRTHDAY_CRON_SECRET (ίδια τιμή με το CRON παρακάτω)

create table if not exists public.birthday_gifts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  patient_id uuid not null references public.patients(id) on delete cascade,
  year integer not null,                        -- έτος γενεθλίων (1 δώρο/έτος)
  channel text not null default 'email',        -- email = στάλθηκε email · call = ειδοποίηση γραμματείας
  sent_at timestamptz not null default now(),
  expires_at date not null,                     -- γενέθλια + 1 μήνας
  redeemed_at timestamptz,
  redeemed_appointment_id uuid references public.appointments(id) on delete set null,
  unique (patient_id, year)
);
create index if not exists birthday_gifts_clinic_id_idx on public.birthday_gifts(clinic_id);
create index if not exists birthday_gifts_patient_id_idx on public.birthday_gifts(patient_id);

-- ── Καθημερινό τρέξιμο 06:00 UTC (09:00 Ελλάδας το καλοκαίρι, 08:00 τον χειμώνα) ──
-- ΑΝΤΙΚΑΤΕΣΤΗΣΕ το REPLACE_WITH_SECRET με την ΙΔΙΑ τιμή που θα βάλεις στο
-- secret BIRTHDAY_CRON_SECRET του function.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('birthday-emails-daily') where exists (select 1 from cron.job where jobname='birthday-emails-daily');
select cron.schedule(
  'birthday-emails-daily',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://kfidxwqgsaisbdgucsok.supabase.co/functions/v1/birthday-emails',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "REPLACE_WITH_SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
