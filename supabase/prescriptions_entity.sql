-- Ηλεκτρονική Συνταγογράφηση (ΗΔΙΚΑ): οντότητα «Συνταγή» ανά κλινική.
-- Εφαρμόστηκε στο production στις 26/09/2026 (migration "prescriptions_entity").
-- Μια συνταγή γεννιέται από μια Ιατρική Εξέταση (medical_exams) ή χειροκίνητα,
-- κρατά στιγμιότυπο διαγνώσεων (ICD-10) και σκευασμάτων (κωδικός ΕΟΦ/barcode)
-- και τον κύκλο ζωής της απέναντι στο ΣΗΣ (draft → sent → issued / error / cancelled).
create table if not exists public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  exam_id uuid references public.medical_exams(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  doctor_id uuid references public.profiles(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','sent','issued','error','cancelled')),
  diagnoses jsonb not null default '[]'::jsonb,   -- [{name, icd10}]
  medicines jsonb not null default '[]'::jsonb,   -- [{name, code, quantity, dosage, days}]
  notes text,
  patient_amka text,
  doctor_amka text,
  prescriber_code text,
  idika_env text not null default 'uat',
  idika_barcode text,
  idika_visit_id text,
  idika_response jsonb,
  preview_xml text,
  error_message text,
  sent_at timestamptz,
  issued_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists prescriptions_clinic_patient_idx on public.prescriptions(clinic_id, patient_id);
create index if not exists prescriptions_clinic_status_idx on public.prescriptions(clinic_id, status, created_at desc);

drop trigger if exists prescriptions_touch_updated_at on public.prescriptions;
create trigger prescriptions_touch_updated_at before update on public.prescriptions
  for each row execute function public.touch_updated_at();

alter table public.prescriptions enable row level security;
-- Ίδια πολιτική με τις Ιατρικές Εξετάσεις: κλινική + δικαίωμα προβολής διάγνωσης.
drop policy if exists prescriptions_select on public.prescriptions;
create policy prescriptions_select on public.prescriptions for select
  using ((is_super_admin() or clinic_id = current_user_clinic_id()) and current_user_can_view_diagnosis());
drop policy if exists prescriptions_insert on public.prescriptions;
create policy prescriptions_insert on public.prescriptions for insert
  with check ((is_super_admin() or clinic_id = current_user_clinic_id()) and current_user_can_view_diagnosis());
drop policy if exists prescriptions_update on public.prescriptions;
create policy prescriptions_update on public.prescriptions for update
  using ((is_super_admin() or clinic_id = current_user_clinic_id()) and current_user_can_view_diagnosis());
drop policy if exists prescriptions_delete on public.prescriptions;
create policy prescriptions_delete on public.prescriptions for delete
  using (is_super_admin() or (is_clinic_admin() and clinic_id = current_user_clinic_id()));

-- Ενεργοποίηση του module μόνο στο Demo Dermatology Clinic (η Beauty Line δεν το βλέπει:
-- το module είναι default-off στο frontend, βλ. TOGGLEABLE_MODULES → defaultOff).
update public.clinics
   set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{enabled_modules,prescriptions}', 'true'::jsonb, true)
 where id = 'a787b766-9d23-45b2-9660-7bb480856a1b';
