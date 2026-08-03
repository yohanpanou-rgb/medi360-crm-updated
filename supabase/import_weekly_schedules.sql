-- Εβδομαδιαίο ωράριο εργασίας ανά μέλος προσωπικού.
-- day_of_week: 0=Κυριακή, 1=Δευτέρα, 2=Τρίτη, 3=Τετάρτη, 4=Πέμπτη, 5=Παρασκευή, 6=Σάββατο
-- (ίδια σύμβαση με JS Date.getDay(), όπως και στον κώδικα του CRM).
-- Κυριακή & Δευτέρα: ρεπό για όλους (δεν αναφέρθηκε ωράριο γι' αυτές τις ημέρες).
-- Ασφαλές να ξανατρέξεις: upsert ανά (staff_id, day_of_week) — δεν δημιουργεί διπλότυπα.

create extension if not exists unaccent;

-- ── ΑΘΑΝΑΣΙΑ (Πελώνη): Τρίτη-Παρασκευή 11:30-20:00, Σάββατο 09:00-17:30 ──
insert into public.staff_schedules (clinic_id, staff_id, day_of_week, is_working, start_time, end_time)
select p.clinic_id, p.id, d.day_of_week, d.is_working, d.start_time, d.end_time
from public.profiles p
cross join (values
  (0, false, null::time, null::time),
  (1, false, null::time, null::time),
  (2, true, '11:30'::time, '20:00'::time),
  (3, true, '11:30'::time, '20:00'::time),
  (4, true, '11:30'::time, '20:00'::time),
  (5, true, '11:30'::time, '20:00'::time),
  (6, true, '09:00'::time, '17:30'::time)
) as d(day_of_week, is_working, start_time, end_time)
where p.clinic_id = (select id from public.clinics where name ilike '%beauty line%')
and unaccent(p.full_name) ilike unaccent('%αθανασ%')
on conflict (staff_id, day_of_week) do update
  set is_working = excluded.is_working, start_time = excluded.start_time, end_time = excluded.end_time;

-- ── ΧΡΙΣΤΙΑΝΝΑ (Αμπούντ): Τρίτη-Παρασκευή 11:30-20:00, Σάββατο 09:00-15:30 ──
insert into public.staff_schedules (clinic_id, staff_id, day_of_week, is_working, start_time, end_time)
select p.clinic_id, p.id, d.day_of_week, d.is_working, d.start_time, d.end_time
from public.profiles p
cross join (values
  (0, false, null::time, null::time),
  (1, false, null::time, null::time),
  (2, true, '11:30'::time, '20:00'::time),
  (3, true, '11:30'::time, '20:00'::time),
  (4, true, '11:30'::time, '20:00'::time),
  (5, true, '11:30'::time, '20:00'::time),
  (6, true, '09:00'::time, '15:30'::time)
) as d(day_of_week, is_working, start_time, end_time)
where p.clinic_id = (select id from public.clinics where name ilike '%beauty line%')
and unaccent(p.full_name) ilike unaccent('%χριστιαν%')
on conflict (staff_id, day_of_week) do update
  set is_working = excluded.is_working, start_time = excluded.start_time, end_time = excluded.end_time;

-- ── ΛΙΝΑ (Lina Panou): Τρίτη-Παρασκευή 10:00-19:00, Σάββατο 09:00-15:00 ──
insert into public.staff_schedules (clinic_id, staff_id, day_of_week, is_working, start_time, end_time)
select p.clinic_id, p.id, d.day_of_week, d.is_working, d.start_time, d.end_time
from public.profiles p
cross join (values
  (0, false, null::time, null::time),
  (1, false, null::time, null::time),
  (2, true, '10:00'::time, '19:00'::time),
  (3, true, '10:00'::time, '19:00'::time),
  (4, true, '10:00'::time, '19:00'::time),
  (5, true, '10:00'::time, '19:00'::time),
  (6, true, '09:00'::time, '15:00'::time)
) as d(day_of_week, is_working, start_time, end_time)
where p.clinic_id = (select id from public.clinics where name ilike '%beauty line%')
and p.full_name ilike '%lina%panou%'
on conflict (staff_id, day_of_week) do update
  set is_working = excluded.is_working, start_time = excluded.start_time, end_time = excluded.end_time;

-- ── ΝΑΝΣΥ: Τρίτη-Παρασκευή 11:30-15:30, Σάββατο 11:00-15:00 ───────────────
insert into public.staff_schedules (clinic_id, staff_id, day_of_week, is_working, start_time, end_time)
select p.clinic_id, p.id, d.day_of_week, d.is_working, d.start_time, d.end_time
from public.profiles p
cross join (values
  (0, false, null::time, null::time),
  (1, false, null::time, null::time),
  (2, true, '11:30'::time, '15:30'::time),
  (3, true, '11:30'::time, '15:30'::time),
  (4, true, '11:30'::time, '15:30'::time),
  (5, true, '11:30'::time, '15:30'::time),
  (6, true, '11:00'::time, '15:00'::time)
) as d(day_of_week, is_working, start_time, end_time)
where p.clinic_id = (select id from public.clinics where name ilike '%beauty line%')
and unaccent(p.full_name) ilike unaccent('%νανσ%')
on conflict (staff_id, day_of_week) do update
  set is_working = excluded.is_working, start_time = excluded.start_time, end_time = excluded.end_time;

-- ── VERIFY ─────────────────────────────────────────────────────────────
select p.full_name,
  array_agg(
    case when s.is_working then to_char(s.start_time,'HH24:MI')||'-'||to_char(s.end_time,'HH24:MI') else 'ΡΕΠΟ' end
    order by s.day_of_week
  ) as ωραριο_κυρ_ως_σαβ
from public.profiles p
join public.staff_schedules s on s.staff_id = p.id
where p.clinic_id = (select id from public.clinics where name ilike '%beauty line%')
group by p.full_name
order by p.full_name;
