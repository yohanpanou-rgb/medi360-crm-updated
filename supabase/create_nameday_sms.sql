-- Εορτολόγιο & SMS (nameday SMS) — πλατφορμικό feature ανά οργανισμό (κλινική).
-- Εφαρμόστηκε ως migration `nameday_sms_feature`.
--
-- • nameday_sms_log: μία εγγραφή ανά (κλινική, πελάτης, ημερομηνία) — έτσι δεν
--   φεύγει ποτέ διπλό SMS την ίδια ημέρα, ακόμη κι αν πατηθεί δύο φορές «Αποστολή».
-- • Το flag ζει στο clinics.settings.nameday_sms:
--     { enabled, approval_required, auto_send, template, send_hour, sender_id }
--   Ενεργό μόνο για το Beauty Line· κάθε άλλη κλινική OFF (δεν βλέπει/τρέχει τίποτα).
-- • Η edge function `nameday-sms` γράφει τις εγγραφές (service role)· οι χρήστες
--   έχουν μόνο ανάγνωση της δικής τους κλινικής.

create table if not exists public.nameday_sms_log (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  nameday_date date not null,
  feast_name text,
  first_name text,
  phone text,
  template text,
  message text,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  provider_message_id text,
  error text,
  sent_by uuid,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (clinic_id, patient_id, nameday_date)
);
create index if not exists nameday_sms_log_clinic_date_idx on public.nameday_sms_log (clinic_id, nameday_date desc);

alter table public.nameday_sms_log enable row level security;
drop policy if exists nameday_sms_log_select on public.nameday_sms_log;
create policy nameday_sms_log_select on public.nameday_sms_log
  for select using (is_super_admin() or clinic_id = current_user_clinic_id());

-- Ο γενικός πίνακας SMS δέχεται και τον νέο τύπο 'nameday'
alter table public.sms_log drop constraint if exists sms_log_sms_type_check;
alter table public.sms_log add constraint sms_log_sms_type_check check (sms_type = any (array[
  'sms1_info','sms2_confirm','sms3_warning','sms4_cancel','google_review','health_history','influencer',
  'booking_confirm','custom','booking_confirmation','confirmation_request','instructions','review_request','nameday'
]));

-- Feature flag: μόνο Beauty Line ενεργό, με έγκριση πριν από κάθε αποστολή.
update public.clinics
set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('nameday_sms', jsonb_build_object(
  'enabled', true, 'approval_required', true, 'auto_send', false,
  'template', null, 'send_hour', 10, 'sender_id', null))
where id = '9e5f4495-ca91-449a-9f87-2ddadb439a77' and (settings->'nameday_sms') is null;

-- Ωριαίο cron (αντιγραφή της εντολής του job 9 με αλλαγή του function name ώστε
-- να μη γραφτεί πουθενά το μυστικό). Στέλνει μόνο για κλινικές με auto_send=true
-- την ώρα send_hour (Αθήνα)· για τις υπόλοιπες δεν κάνει τίποτα.
-- select cron.schedule('nameday-sms-hourly', '5 * * * *',
--   replace(command, '/functions/v1/appointment-automations', '/functions/v1/nameday-sms'))
-- from cron.job where jobname = 'appointment-automations-hourly';
