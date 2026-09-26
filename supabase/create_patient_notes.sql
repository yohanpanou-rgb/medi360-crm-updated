-- Χρονολογημένες σημειώσεις πελάτη (UX audit P2, απόφαση 5).
-- Εφαρμόστηκε στο production στις 26/09/2026 (migration "create_patient_notes").
--
-- Μέχρι τώρα η «σημείωση» ήταν ένα ελεύθερο πεδίο (patients.notes) που το έγραφε
-- όποιος έγραφε τελευταίος. Εδώ κάθε σημείωση έχει ποιος/πότε, ώστε να μπαίνει ως
-- γεγονός στο Ιστορικό της καρτέλας. Το patients.notes ΜΕΝΕΙ ως «σταθερή σημείωση»
-- (προτιμήσεις, τι να θυμόμαστε) — δεν μεταναστεύει, δεν αλλάζει.
--
-- Ο πίνακας έχει FK στο patients με on delete cascade, οπότε καλύπτεται αυτόματα από
-- delete_patient_completely / merge_patient_records (patient_ref_columns() βρίσκει
-- δυναμικά τις στήλες patient_id).

create table if not exists public.patient_notes (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  patient_id uuid not null references public.patients(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null check (length(btrim(body)) > 0),
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists patient_notes_patient_idx on public.patient_notes(patient_id, created_at desc);
create index if not exists patient_notes_clinic_idx on public.patient_notes(clinic_id);

alter table public.patient_notes enable row level security;

-- Ίδιο μοτίβο με patient_photos / patient_relationships: όλοι οι ρόλοι της κλινικής
-- διαβάζουν και γράφουν· επεξεργασία/διαγραφή μόνο ο συντάκτης ή διαχειριστής.
drop policy if exists patient_notes_select on public.patient_notes;
create policy patient_notes_select on public.patient_notes for select
  using (public.is_super_admin() or clinic_id = public.current_user_clinic_id());

drop policy if exists patient_notes_insert on public.patient_notes;
create policy patient_notes_insert on public.patient_notes for insert
  with check (public.is_super_admin() or clinic_id = public.current_user_clinic_id());

drop policy if exists patient_notes_update on public.patient_notes;
create policy patient_notes_update on public.patient_notes for update
  using (public.is_super_admin() or (clinic_id = public.current_user_clinic_id() and (author_id = auth.uid() or public.is_clinic_admin())))
  with check (public.is_super_admin() or clinic_id = public.current_user_clinic_id());

drop policy if exists patient_notes_delete on public.patient_notes;
create policy patient_notes_delete on public.patient_notes for delete
  using (public.is_super_admin() or (clinic_id = public.current_user_clinic_id() and (author_id = auth.uid() or public.is_clinic_admin())));

revoke all on public.patient_notes from anon;
grant select, insert, update, delete on public.patient_notes to authenticated;
