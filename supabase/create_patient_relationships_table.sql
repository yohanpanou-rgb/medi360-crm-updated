-- New table: links two patients together with a relationship label
-- (π.χ. "Γονέας - Παιδί" για μαμά/κόρη, "Σύζυγοι", "Αδέρφια"...), ώστε το
-- CRM να ξέρει ότι δύο κάρτες ασθενών ανήκουν στην ίδια οικογένεια/παρέα.
--
-- Ένα μόνο row ανά ζευγάρι (όχι δύο κατευθύνσεις) — όποιος ασθενής ανοίξει
-- την κάρτα του, το UI ψάχνει και στις δύο στήλες (patient_a_id OR
-- patient_b_id) για να βρει όλους τους συσχετισμούς του.
--
-- Run this once in the Supabase SQL Editor, THEN re-run rls_policies.sql
-- (safe to re-run) so this new table gets the same clinic-scoped RLS
-- policies as τα υπόλοιπα (πλήρες read/write για όλους τους ρόλους της
-- κλινικής, όπως και τα patient_photos).

create table if not exists public.patient_relationships (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  patient_a_id uuid not null,
  patient_b_id uuid not null,
  relationship_type text not null,
  created_at timestamptz not null default now(),
  constraint patient_relationships_patient_a_fkey
    foreign key (patient_a_id) references public.patients(id) on delete cascade,
  constraint patient_relationships_patient_b_fkey
    foreign key (patient_b_id) references public.patients(id) on delete cascade,
  constraint patient_relationships_no_self check (patient_a_id <> patient_b_id)
);

create index if not exists patient_relationships_a_idx
  on public.patient_relationships(patient_a_id);
create index if not exists patient_relationships_b_idx
  on public.patient_relationships(patient_b_id);
create index if not exists patient_relationships_clinic_idx
  on public.patient_relationships(clinic_id);

-- Αποτρέπει διπλή καταχώρηση του ίδιου ζευγαριού+τύπου ανεξαρτήτως σειράς
-- (A,B) vs (B,A).
create unique index if not exists patient_relationships_unique_pair
  on public.patient_relationships (
    clinic_id,
    least(patient_a_id, patient_b_id),
    greatest(patient_a_id, patient_b_id),
    relationship_type
  );
