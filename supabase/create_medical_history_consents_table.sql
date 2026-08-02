-- New table: stores a full, immutable snapshot of the GDPR & Ιατρικό Ιστορικό
-- form each time it's signed with a signature (optional step on top of the
-- existing openHistoryFormModal() form — leaving patients.gdpr_signed /
-- medical_history_completed and every automation that reads them completely
-- unchanged). "Προβολή" reads the most recent row here to show the form
-- exactly as the patient filled and signed it, instead of just the live
-- (and possibly since-edited) patient fields.
--
-- Run this once in the Supabase SQL Editor, THEN re-run rls_policies.sql
-- (safe to re-run) so this new table gets the same clinic-scoped RLS
-- policies as laser_consents/service_consents.

create table if not exists public.medical_history_consents (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  patient_id uuid not null references public.patients(id),
  signed_at timestamptz not null default now(),
  signature_data text,
  collected_by text,
  consent_version text not null default 'v1',
  -- Πλήρες στιγμιότυπο των πεδίων της φόρμας τη στιγμή της υπογραφής (όνομα, dob,
  -- τηλέφωνο, email, πόλη, πηγή, επιλεγμένες παθήσεις, αλλεργίες, φαρμακευτική
  -- αγωγή, προηγούμενες θεραπείες, περιοχές αποφυγής, marketing) — ώστε η
  -- προβολή να δείχνει ό,τι ΑΚΡΙΒΩΣ υπογράφηκε, ακόμα κι αν η καρτέλα του
  -- ασθενή αλλάξει αργότερα.
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists medical_history_consents_patient_id_idx
  on public.medical_history_consents(patient_id);
create index if not exists medical_history_consents_clinic_id_idx
  on public.medical_history_consents(clinic_id);
