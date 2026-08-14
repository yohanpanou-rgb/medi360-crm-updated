-- 📬 Αυτοματισμοί Ραντεβού: επιβεβαίωση 48ωρου + οδηγίες πριν/μετά τη θεραπεία.
--
-- Ροή: νέο μελλοντικό ραντεβού = ΚΛΕΙΣΜΕΝΟ (booked) → 48 ώρες πριν φεύγει
-- email με κουμπί «Επιβεβαιώνω» → ο πελάτης πατάει → ΕΠΙΒΕΒΑΙΩΜΕΝΟ →
-- αυτόματο email με οδηγίες ΠΡΙΝ + ΜΕΤΑ, βάσει του Instruction Set της
-- υπηρεσίας. Ραντεβού που κλείνονται ≤48 ώρες πριν μπαίνουν κατευθείαν
-- ΕΠΙΒΕΒΑΙΩΜΕΝΑ και παίρνουν οδηγίες αμέσως. Κανάλι: email τώρα, Viber
-- αργότερα (ίδιο router/endpoint).
--
-- Τρέξε το ΜΙΑ φορά στο SQL Editor. Πριν το cron.schedule στο τέλος,
-- αντικατέστησε το REPLACE_WITH_SECRET με το BIRTHDAY_CRON_SECRET.

-- 1. Σετ οδηγιών (τα κείμενα τα γράφει η διαχείριση από το CRM)
create table if not exists public.instruction_sets (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  description text,
  pre_instructions text,
  post_instructions text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2. Αντιστοίχιση Υπηρεσία → Σετ οδηγιών (πολλές υπηρεσίες ανά σετ,
--    μία υπηρεσία σε ΕΝΑ σετ)
create table if not exists public.service_instruction_map (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  instruction_set_id uuid not null references public.instruction_sets(id) on delete cascade,
  unique (service_id)
);

-- 3. Ιστορικό επικοινωνιών/αυτοματισμών (confirmation requests, οδηγίες,
--    επιβεβαιώσεις πελατών, χειροκίνητες επαναποστολές)
create table if not exists public.communication_log (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete cascade,
  patient_id uuid references public.patients(id) on delete cascade,
  automation_type text not null,  -- confirmation_request | instructions | confirmation_received
  channel text not null default 'email',  -- email | viber | manual
  recipient text,
  cycle text not null default '',  -- start_time του ραντεβού τη στιγμή της ενέργειας (νέος «κύκλος» σε κάθε reschedule)
  status text not null,            -- sent | failed | no_email | no_set | received
  error text,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists communication_log_appt_idx on public.communication_log(appointment_id);

-- Idempotency: το ίδιο ραντεβού δεν παίρνει δεύτερη φορά το ίδιο automation
-- στον ίδιο κύκλο (αλλαγή ώρας = νέος κύκλος = νέα αποστολή, σωστά).
create unique index if not exists communication_log_once
  on public.communication_log(appointment_id, automation_type, cycle)
  where status = 'sent';

-- 4. Καθημερινός/ωριαίος έλεγχος: ποια ΚΛΕΙΣΜΕΝΑ μπαίνουν στο 48ωρο →
--    αίτημα επιβεβαίωσης · ποια ΕΠΙΒΕΒΑΙΩΜΕΝΑ δεν έχουν πάρει οδηγίες → οδηγίες.
select cron.schedule(
  'appointment-automations-hourly',
  '15 * * * *',
  $$
  select net.http_post(
    url := 'https://kfidxwqgsaisbdgucsok.supabase.co/functions/v1/appointment-automations',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "REPLACE_WITH_SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
