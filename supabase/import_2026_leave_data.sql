-- Εισαγωγή των πραγματικών αδειών 2026 (από το φύλλο "Άδειες 2026") στο
-- νέο σύστημα Προσωπικό & Υπηρεσίες → Ωράριο & Άδειες.
-- Η Λίνα (clinic manager) δεν παίρνει άδεια, άρα δεν συμπεριλαμβάνεται.
-- Ασφαλές να ξανατρέξεις: το INSERT παρακάτω ελέγχει πρώτα αν η εγγραφή
-- υπάρχει ήδη (ίδιο άτομο + ίδια ημερομηνία) πριν την προσθέσει.

-- ── 1. PREVIEW — επιβεβαίωσε ότι ταιριάζουν τα σωστά 4 άτομα ─────────────
select id, full_name, role, annual_leave_days
from public.profiles
where clinic_id = (select id from public.clinics where name ilike '%beauty line%')
and (full_name ilike '%στελλ%' or full_name ilike '%αθανασ%' or full_name ilike '%χριστιαν%' or full_name ilike '%νανσ%');

-- ── 2. UPDATE — ετήσια ποσόστωση ανά άτομο (Δικαιούμενες) ─────────────────
update public.profiles set annual_leave_days = 22
where clinic_id = (select id from public.clinics where name ilike '%beauty line%') and full_name ilike '%στελλ%';

update public.profiles set annual_leave_days = 18
where clinic_id = (select id from public.clinics where name ilike '%beauty line%') and full_name ilike '%αθανασ%';

update public.profiles set annual_leave_days = 22
where clinic_id = (select id from public.clinics where name ilike '%beauty line%') and full_name ilike '%χριστιαν%';

update public.profiles set annual_leave_days = 3
where clinic_id = (select id from public.clinics where name ilike '%beauty line%') and full_name ilike '%νανσ%';

-- ── 3. INSERT — ΑΘΑΝΑΣΙΑ: 9 ημέρες "ΚΑΝΟΝΙΚΗ" (καταχωρούνται ως Διακοπές) ──
insert into public.staff_time_off (clinic_id, staff_id, start_date, end_date, type, days_count)
select p.clinic_id, p.id, d, d, 'vacation', 1
from public.profiles p, unnest(array[
  '2026-04-10','2026-04-11','2026-06-09','2026-06-10','2026-06-30','2026-07-01',
  '2026-08-14','2026-08-18','2026-08-19'
]::date[]) as d
where p.clinic_id = (select id from public.clinics where name ilike '%beauty line%')
and p.full_name ilike '%αθανασ%'
and not exists (
  select 1 from public.staff_time_off t where t.staff_id = p.id and t.start_date = d and t.end_date = d
);

-- ── 4. INSERT — ΧΡΙΣΤΙΑΝΝΑ: 17 ημέρες "ΚΑΝΟΝΙΚΗ" ──────────────────────────
insert into public.staff_time_off (clinic_id, staff_id, start_date, end_date, type, days_count)
select p.clinic_id, p.id, d, d, 'vacation', 1
from public.profiles p, unnest(array[
  '2026-05-22','2026-05-26','2026-06-17','2026-06-18','2026-06-19','2026-06-23','2026-06-24',
  '2026-08-14','2026-08-18','2026-08-19','2026-08-20','2026-08-21','2026-08-25','2026-08-26','2026-08-27','2026-08-28','2026-08-29'
]::date[]) as d
where p.clinic_id = (select id from public.clinics where name ilike '%beauty line%')
and p.full_name ilike '%χριστιαν%'
and not exists (
  select 1 from public.staff_time_off t where t.staff_id = p.id and t.start_date = d and t.end_date = d
);

-- ΣΤΕΛΛΑ και ΝΑΝΣΥ δεν έχουν ληφθείσες ημέρες ακόμα (0) — μόνο η ποσόστωση ενημερώθηκε.

-- ── 5. VERIFY ──────────────────────────────────────────────────────────
select p.full_name, p.annual_leave_days as δικαιουμενες,
  coalesce(sum(t.days_count) filter (where extract(year from t.start_date)=2026), 0) as ληφθεισες,
  p.annual_leave_days - coalesce(sum(t.days_count) filter (where extract(year from t.start_date)=2026), 0) as υπολοιπο
from public.profiles p
left join public.staff_time_off t on t.staff_id = p.id and t.type='vacation'
where p.clinic_id = (select id from public.clinics where name ilike '%beauty line%')
and (p.full_name ilike '%στελλ%' or p.full_name ilike '%αθανασ%' or p.full_name ilike '%χριστιαν%' or p.full_name ilike '%νανσ%')
group by p.id, p.full_name, p.annual_leave_days
order by p.full_name;
