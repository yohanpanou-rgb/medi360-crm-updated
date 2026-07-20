-- ============================================================================
-- Backfill medical_history_completed for existing patients — run ONCE
-- ============================================================================
-- The "Ιατρικό Ιστορικό" badge used to be computed from whether the free-text
-- fields (medical_history/allergies/medications/previous_treatments) were
-- non-empty. That's wrong: a patient who genuinely has nothing to declare
-- (no allergies, no medications, no previous treatments) fills the SAME
-- form and signs GDPR, but ends up with all four fields blank — so the CRM
-- showed "❌ Δεν έχει συμπληρώσει" even though they had completed it.
--
-- The app now writes medical_history_completed/medical_history_completed_at
-- explicitly every time the History Form is saved (or a historical row is
-- matched/imported). This one-time backfill fixes patients whose form was
-- already completed before that fix shipped: since GDPR consent and medical
-- history are captured by the exact same form submission, gdpr_signed = true
-- is proof the form was completed, regardless of what the free-text fields
-- contain.
--
-- Run this ONCE in the Supabase SQL Editor (Dashboard > SQL Editor > New query).

update patients
set
  medical_history_completed = true,
  medical_history_completed_at = coalesce(medical_history_completed_at, gdpr_signed_at, created_at)
where gdpr_signed = true
  and (medical_history_completed is null or medical_history_completed = false);
