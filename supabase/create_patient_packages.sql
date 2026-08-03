-- Πακέτα Συνεδριών (π.χ. Laser x6): αγορασμένα πακέτα ανά ασθενή, με σύνδεση
-- κάθε ραντεβού που "καταναλώνει" συνεδρία μέσω appointments.package_id —
-- έτσι το υπόλοιπο (π.χ. 3/6) υπολογίζεται πάντα από τα πραγματικά ραντεβού,
-- με πλήρη ιχνηλασιμότητα ποια συνεδρία έγινε πότε.
--
-- Run this once στο Supabase SQL Editor, ΜΕΤΑ ξανατρέξε το rls_policies.sql
-- (ήδη ενημερωμένο να συμπεριλάβει τον πίνακα patient_packages).

create table if not exists public.patient_packages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  patient_id uuid not null references public.patients(id) on delete cascade,
  name text not null,                          -- π.χ. "Laser Μασχάλες x6"
  service_name text,                           -- για αυτόματο ταίριασμα με ραντεβού (προαιρετικό)
  total_sessions integer not null default 6,
  price numeric,                               -- συνολική τιμή πακέτου (προαιρετική)
  purchased_at date not null default current_date,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists patient_packages_clinic_id_idx on public.patient_packages(clinic_id);
create index if not exists patient_packages_patient_id_idx on public.patient_packages(patient_id);

alter table public.appointments
  add column if not exists package_id uuid references public.patient_packages(id) on delete set null;
create index if not exists appointments_package_id_idx on public.appointments(package_id);
