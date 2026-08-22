-- 🧾 myDATA απόδειξη — επέκταση σε Πακέτα και μεμονωμένες Πωλήσεις Καλλυντικού.
-- Ίδιες receipt_* στήλες με το appointments (add_receipt_columns_to_appointments.sql).
--
-- Run once στο SQL Editor.

alter table public.patient_packages
  add column if not exists receipt_mark text,
  add column if not exists receipt_issued_at timestamptz,
  add column if not exists receipt_amount numeric,
  add column if not exists receipt_payment_method text,
  add column if not exists receipt_error text;

-- Νέος πίνακας: μεμονωμένη πώληση καλλυντικού από τη σελίδα "Πώληση Καλλυντικού"
-- (index.html, renderProductSale) — ανεξάρτητη από ραντεβού/πακέτο, ο πελάτης
-- είναι προαιρετικός (περαστικός πελάτης χωρίς καρτέλα επιτρέπεται).
create table if not exists public.product_sales (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  patient_id uuid references public.patients(id),
  product_name text not null,
  quantity numeric not null default 1,
  unit_price numeric,
  amount numeric not null,
  payment_method text,
  receipt_mark text,
  receipt_issued_at timestamptz,
  receipt_error text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists product_sales_clinic_idx on public.product_sales(clinic_id, created_at desc);

alter table public.product_sales enable row level security;

drop policy if exists "product_sales_select" on public.product_sales;
create policy "product_sales_select" on public.product_sales
  for select using (
    public.is_super_admin()
    or clinic_id = public.current_user_clinic_id()
  );

drop policy if exists "product_sales_insert" on public.product_sales;
create policy "product_sales_insert" on public.product_sales
  for insert with check (
    public.is_super_admin()
    or clinic_id = public.current_user_clinic_id()
  );

drop policy if exists "product_sales_update" on public.product_sales;
create policy "product_sales_update" on public.product_sales
  for update using (
    public.is_super_admin()
    or clinic_id = public.current_user_clinic_id()
  ) with check (
    public.is_super_admin()
    or clinic_id = public.current_user_clinic_id()
  );
