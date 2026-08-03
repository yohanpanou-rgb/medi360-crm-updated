-- Ωράριο Λειτουργίας Ινστιτούτου (από το Google Business Profile):
-- Κυριακή/Δευτέρα κλειστά, Τρίτη-Παρασκευή 10:00-19:30, Σάββατο 09:00-17:00.
-- Ειδικές κλειστές ημέρες: 14, 17, 18, 19 Αυγούστου 2026.
-- Ασφαλές να ξανατρέξεις: αντικαθιστά μόνο το κλειδί "business_hours" μέσα
-- στο settings, χωρίς να πειράζει τίποτα άλλο (consultation_services κ.λπ.).

-- ── 1. PREVIEW ─────────────────────────────────────────────────────────
select id, name, settings->'business_hours' as current_business_hours
from public.clinics
where name ilike '%beauty line%';

-- ── 2. UPDATE ──────────────────────────────────────────────────────────
update public.clinics
set settings = jsonb_set(
  coalesce(settings, '{}'::jsonb),
  '{business_hours}',
  '{
    "schedule": [
      {"day_of_week": 0, "is_open": false, "start": "10:00", "end": "19:30"},
      {"day_of_week": 1, "is_open": false, "start": "10:00", "end": "19:30"},
      {"day_of_week": 2, "is_open": true,  "start": "10:00", "end": "19:30"},
      {"day_of_week": 3, "is_open": true,  "start": "10:00", "end": "19:30"},
      {"day_of_week": 4, "is_open": true,  "start": "10:00", "end": "19:30"},
      {"day_of_week": 5, "is_open": true,  "start": "10:00", "end": "19:30"},
      {"day_of_week": 6, "is_open": true,  "start": "09:00", "end": "17:00"}
    ],
    "closed_dates": ["2026-08-14", "2026-08-17", "2026-08-18", "2026-08-19"]
  }'::jsonb
)
where name ilike '%beauty line%';

-- ── 3. VERIFY ──────────────────────────────────────────────────────────
select id, name, settings->'business_hours' as updated_business_hours
from public.clinics
where name ilike '%beauty line%';
