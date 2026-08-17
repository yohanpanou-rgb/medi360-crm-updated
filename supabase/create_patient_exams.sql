-- 🩺 Φάκελος Εξετάσεων ανά ασθενή: ανέβασμα εγγράφου/φωτογραφίας εξέτασης με
-- ημερομηνία, ταξινομημένα χρονολογικά. Η AI ταξινόμηση (τύπος + σύντομη
-- περίληψη) γίνεται από το edge function 'classify-exam' (Claude API) — εδώ
-- μόνο ο πίνακας + το bucket + τα RLS policies.
--
-- Ίδιο μοτίβο με το ήδη υπάρχον patient_photos: ιδιωτικό (private) storage
-- bucket, μονοπάτια αρχείων `${clinic_id}/${patient_id}/${filename}`, RLS
-- policies scoped by clinic.
--
-- Run once στο SQL Editor. Μετά τρέξε ΟΛΟΚΛΗΡΟ το rls_policies.sql ξανά
-- (το 'patient_exams' έχει ήδη προστεθεί στα arrays εκεί).

create table if not exists public.patient_exams (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  patient_id uuid not null references public.patients(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  exam_date date not null default current_date,
  ai_type text,                          -- π.χ. "Αιματολογική εξέταση" — πρόταση AI, επιβεβαιώνεται χειροκίνητα
  ai_summary text,                       -- σύντομη περίληψη AI (1-2 προτάσεις, ελληνικά)
  ai_status text not null default 'pending' check (ai_status in ('pending','done','failed')),
  confirmed boolean not null default false,  -- η θεραπεύτρια επιβεβαίωσε την πρόταση AI
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists patient_exams_patient_idx on public.patient_exams(patient_id);
create index if not exists patient_exams_clinic_idx on public.patient_exams(clinic_id);

alter table public.patient_exams enable row level security;

-- Private storage bucket (χωρίς αυτό, οι signed URLs στο app δεν έχουν πού
-- να δείξουν). Αν αποτύχει επειδή δεν έχεις δικαίωμα SQL πάνω στο storage
-- σχήμα, φτιάξ' το χειροκίνητα από το Dashboard → Storage → New bucket
-- (όνομα: patient-exams, Public: OFF) και αγνόησε αυτή τη γραμμή.
insert into storage.buckets (id, name, public)
values ('patient-exams', 'patient-exams', false)
on conflict (id) do nothing;
