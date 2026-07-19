-- ============================================================================
-- New patient columns for the in-CRM "Ιατρικό Ιστορικό" form
-- ============================================================================
-- Run this ONCE in the Supabase SQL Editor. Adds the 2 fields from the
-- reference Google Form (https://docs.google.com/forms/d/1NO9WX5w6jGOJP90yOvNfta7N7OxuHdQbmfVCGaiRfVI)
-- that don't already have a home in the patients table:
--   - "Περιοχές του σώματος προς αποφυγή"  -> avoid_body_areas
--   - "Θέλω να λαμβάνω email με προσφορές..." -> marketing_opt_in
-- Every other field on that form (name, dob, phone, email, city, source,
-- medical history, allergies, medications, previous treatments, GDPR) already
-- has a matching patients column.
-- ============================================================================

alter table public.patients
  add column if not exists avoid_body_areas text,
  add column if not exists marketing_opt_in boolean,
  add column if not exists gdpr_signed_at timestamptz;
