-- Retire the 'pending' and 'paid' appointment statuses.
-- The CRM no longer offers these as choices — new appointments default to
-- 'confirmed', and 'paid' was always treated as equivalent to 'completed'
-- everywhere in the app (revenue/stats). This migration reclassifies any
-- EXISTING rows so the live data matches what the UI can now produce.
--
-- Run the SELECT below FIRST to see exactly how many rows will change and
-- a sample of them, before running the UPDATE.

-- ── 1. PREVIEW (safe, read-only) ──────────────────────────────────────────
select status, count(*) as how_many
from public.appointments
where status in ('pending', 'paid')
group by status;

-- ── 2. UPDATE (run only after checking the preview above) ─────────────────
update public.appointments set status = 'confirmed' where status = 'pending';
update public.appointments set status = 'completed' where status = 'paid';

-- ── 3. VERIFY — should return zero rows ────────────────────────────────────
select id, status from public.appointments where status in ('pending', 'paid');
