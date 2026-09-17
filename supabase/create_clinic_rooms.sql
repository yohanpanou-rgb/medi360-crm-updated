-- Δωμάτια ανά κλινική — εφαρμόστηκε ως migration `create_clinic_rooms`.
-- Πρόγραμμα «Ανά δωμάτιο»: στήλες = clinic_rooms της κλινικής. Δωμάτιο ραντεβού =
-- appointments.room_id (χειροκίνητο) → services.default_room_id → «Χωρίς δωμάτιο».
create table if not exists public.clinic_rooms (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  color text,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists clinic_rooms_clinic_idx on public.clinic_rooms (clinic_id, sort_order);
alter table public.clinic_rooms enable row level security;
create policy clinic_rooms_select on public.clinic_rooms for select using (is_super_admin() or clinic_id = current_user_clinic_id());
create policy clinic_rooms_insert on public.clinic_rooms for insert with check (is_super_admin() or clinic_id = current_user_clinic_id());
create policy clinic_rooms_update on public.clinic_rooms for update using (is_super_admin() or clinic_id = current_user_clinic_id()) with check (is_super_admin() or clinic_id = current_user_clinic_id());
create policy clinic_rooms_delete on public.clinic_rooms for delete using (is_super_admin() or (is_clinic_admin() and clinic_id = current_user_clinic_id()));
alter table public.appointments add column if not exists room_id uuid references public.clinic_rooms(id) on delete set null;
alter table public.services add column if not exists default_room_id uuid references public.clinic_rooms(id) on delete set null;
create index if not exists appointments_room_idx on public.appointments (room_id) where room_id is not null;
-- Τα demo δεδομένα (4 δωμάτια, προεπιλογές, backfill) βρίσκονται στο seed_demo_clinic.sql §14.
