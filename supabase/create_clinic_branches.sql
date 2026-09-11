-- Υποκαταστήματα (branches) — μια κλινική μπορεί να έχει πάνω από ένα φυσικό
-- σημείο εξυπηρέτησης. Ξεχωριστό, ελαφρύ concept από τον πίνακα `clinics`
-- (που είναι πλήρης multi-tenant απομόνωση, μόνο για super_admin) — τα
-- υποκαταστήματα μοιράζονται το ίδιο προσωπικό/πελάτες/ρυθμίσεις της
-- κλινικής, καταχωρούνται από Settings (clinic_admin) και μπαίνουν σαν
-- προαιρετική ετικέτα σε ραντεβού/ωράρια.
--
-- Τρέξε το ΜΙΑ φορά στο SQL Editor (ασφαλές να ξανατρέξει).

create table if not exists public.clinic_branches (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  address text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists clinic_branches_clinic_id_idx on public.clinic_branches(clinic_id);

-- Προαιρετική στήλη υποκαταστήματος — μηδενική παντού, ώστε κλινικές χωρίς
-- κανένα καταχωρημένο υποκατάστημα να συνεχίσουν να λειτουργούν ακριβώς όπως
-- πριν, χωρίς καμία αλλαγή συμπεριφοράς.
alter table public.appointments add column if not exists branch_id uuid references public.clinic_branches(id) on delete set null;
alter table public.staff_schedules add column if not exists branch_id uuid references public.clinic_branches(id) on delete set null;
alter table public.staff_schedule_overrides add column if not exists branch_id uuid references public.clinic_branches(id) on delete set null;

create index if not exists appointments_branch_id_idx on public.appointments(branch_id);
create index if not exists staff_schedules_branch_id_idx on public.staff_schedules(branch_id);
create index if not exists staff_schedule_overrides_branch_id_idx on public.staff_schedule_overrides(branch_id);

-- RLS — ίδιο μοτίβο clinic-scoping με όλους τους υπόλοιπους πίνακες
-- (βλ. rls_policies.sql): οποιοσδήποτε στην κλινική βλέπει/γράφει, μόνο
-- clinic_admin/super_admin διαγράφει.
alter table public.clinic_branches enable row level security;

drop policy if exists "clinic_branches_select" on public.clinic_branches;
create policy "clinic_branches_select" on public.clinic_branches
  for select
  using (
    public.is_super_admin()
    or clinic_id = public.current_user_clinic_id()
  );

drop policy if exists "clinic_branches_insert" on public.clinic_branches;
create policy "clinic_branches_insert" on public.clinic_branches
  for insert
  with check (
    public.is_super_admin()
    or clinic_id = public.current_user_clinic_id()
  );

drop policy if exists "clinic_branches_update" on public.clinic_branches;
create policy "clinic_branches_update" on public.clinic_branches
  for update
  using (
    public.is_super_admin()
    or clinic_id = public.current_user_clinic_id()
  )
  with check (
    public.is_super_admin()
    or clinic_id = public.current_user_clinic_id()
  );

drop policy if exists "clinic_branches_delete" on public.clinic_branches;
create policy "clinic_branches_delete" on public.clinic_branches
  for delete
  using (
    public.is_super_admin()
    or (public.is_clinic_admin() and clinic_id = public.current_user_clinic_id())
  );
