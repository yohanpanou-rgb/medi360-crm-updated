-- 🧴 Καταγραφή Αναλώσιμων ανά ραντεβού (index.html, apptConsumablesAreaHtml).
-- Ανεξάρτητο από το κοστολόγιο ανά υπηρεσία (services.consumables — η
-- "συνταγή"): εδώ καταγράφεται η πραγματική κατανάλωση σε ένα συγκεκριμένο
-- ολοκληρωμένο ραντεβού. Η οθόνη παραμένει κρυμμένη μέχρι να ενεργοποιηθεί
-- ρητά από clinics.settings.consumables_tracking_enabled (Ρυθμίσεις →
-- Κλινική) — καμία αλλαγή settings δεν χρειάζεται εδώ, μένει false/ανύπαρκτο
-- μέχρι να το ενεργοποιήσει ο χρήστης.
--
-- Run once στο SQL Editor.

create table if not exists public.appointment_consumables (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  patient_id uuid references public.patients(id),
  item_name text not null,
  quantity numeric not null default 1,
  unit text,
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists appointment_consumables_appt_idx on public.appointment_consumables(appointment_id, created_at asc);
create index if not exists appointment_consumables_clinic_idx on public.appointment_consumables(clinic_id, created_at desc);

alter table public.appointment_consumables enable row level security;

drop policy if exists "appointment_consumables_select" on public.appointment_consumables;
create policy "appointment_consumables_select" on public.appointment_consumables
  for select using (
    public.is_super_admin()
    or clinic_id = public.current_user_clinic_id()
  );

drop policy if exists "appointment_consumables_insert" on public.appointment_consumables;
create policy "appointment_consumables_insert" on public.appointment_consumables
  for insert with check (
    public.is_super_admin()
    or clinic_id = public.current_user_clinic_id()
  );

drop policy if exists "appointment_consumables_delete" on public.appointment_consumables;
create policy "appointment_consumables_delete" on public.appointment_consumables
  for delete using (
    public.is_super_admin()
    or clinic_id = public.current_user_clinic_id()
  );
