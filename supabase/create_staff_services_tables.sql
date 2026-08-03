-- Νέα οντότητα "Προσωπικό & Υπηρεσίες": καταλόγος υπηρεσιών (διάρκεια/τιμή),
-- ανάθεση υπηρεσιών ανά μέλος προσωπικού, εβδομαδιαίο ωράριο + μεμονωμένες
-- εξαιρέσεις ανά ημέρα, και άδειες/διακοπές με ατομικό ετήσιο υπόλοιπο.
--
-- Run this once στο Supabase SQL Editor, ΜΕΤΑ ξανατρέξε το rls_policies.sql
-- (είναι ήδη ενημερωμένο να συμπεριλάβει αυτούς τους νέους πίνακες).

-- ── 1. Υπηρεσίες (κατάλογος: όνομα, κατηγορία, διάρκεια, τιμή) ────────────
create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  name text not null,
  category text,
  duration_minutes integer not null default 60,
  price numeric,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists services_clinic_id_idx on public.services(clinic_id);

-- ── 2. Ανάθεση υπηρεσιών ανά μέλος προσωπικού (many-to-many) ──────────────
create table if not exists public.staff_services (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  staff_id uuid not null references public.profiles(id),
  service_id uuid not null references public.services(id),
  created_at timestamptz not null default now(),
  unique(staff_id, service_id)
);
create index if not exists staff_services_clinic_id_idx on public.staff_services(clinic_id);
create index if not exists staff_services_staff_id_idx on public.staff_services(staff_id);
create index if not exists staff_services_service_id_idx on public.staff_services(service_id);

-- ── 3. Εβδομαδιαίο ωράριο εργασίας (σταθερό, ανά ημέρα εβδομάδας) ─────────
-- day_of_week: 0=Κυριακή, 1=Δευτέρα, ... 6=Σάββατο (ίδια σύμβαση με JS Date.getDay())
create table if not exists public.staff_schedules (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  staff_id uuid not null references public.profiles(id),
  day_of_week smallint not null check (day_of_week between 0 and 6),
  is_working boolean not null default true,
  start_time time,
  end_time time,
  created_at timestamptz not null default now(),
  unique(staff_id, day_of_week)
);
create index if not exists staff_schedules_clinic_id_idx on public.staff_schedules(clinic_id);
create index if not exists staff_schedules_staff_id_idx on public.staff_schedules(staff_id);

-- ── 4. Μεμονωμένες αλλαγές ωραρίου σε συγκεκριμένη ημερομηνία ─────────────
-- (π.χ. "αυτή την Τρίτη δουλεύει 10:00-14:00 αντί για το κανονικό ωράριο")
create table if not exists public.staff_schedule_overrides (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  staff_id uuid not null references public.profiles(id),
  date date not null,
  is_working boolean not null default true,
  start_time time,
  end_time time,
  notes text,
  created_at timestamptz not null default now(),
  unique(staff_id, date)
);
create index if not exists staff_schedule_overrides_clinic_id_idx on public.staff_schedule_overrides(clinic_id);
create index if not exists staff_schedule_overrides_staff_id_idx on public.staff_schedule_overrides(staff_id);

-- ── 5. Άδειες / Διακοπές ──────────────────────────────────────────────────
create table if not exists public.staff_time_off (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  staff_id uuid not null references public.profiles(id),
  start_date date not null,
  end_date date not null,
  type text not null default 'vacation', -- vacation | sick | other
  days_count numeric not null default 1,
  notes text,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists staff_time_off_clinic_id_idx on public.staff_time_off(clinic_id);
create index if not exists staff_time_off_staff_id_idx on public.staff_time_off(staff_id);
create index if not exists staff_time_off_dates_idx on public.staff_time_off(start_date, end_date);

-- ── 6. Ατομικό ετήσιο υπόλοιπο ημερών άδειας ανά μέλος προσωπικού ─────────
alter table public.profiles
  add column if not exists annual_leave_days numeric not null default 20;
