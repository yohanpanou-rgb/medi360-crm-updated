-- Ανάθεση υπηρεσιών ανά μέλος προσωπικού, όπως στο excel (Λίνα, Χριστιάνα,
-- Αθανασία, Νάνσυ έχουν ✓ σε όλες τις 97 υπηρεσίες).
-- Χρησιμοποιεί unaccent() για ταίριασμα ονομάτων χωρίς πρόβλημα τόνων.
-- Ασφαλές να ξανατρέξεις: παραλείπει όποιο ζευγάρι (άτομο, υπηρεσία) υπάρχει ήδη.

-- ── 1. PREVIEW — πόσες αναθέσεις υπάρχουν ήδη ανά άτομο ──────────────────
select p.full_name, count(ss.id) as ήδη_ανατεθειμένες
from public.profiles p
left join public.staff_services ss on ss.staff_id = p.id
where p.clinic_id = (select id from public.clinics where name ilike '%beauty line%')
group by p.full_name
order by p.full_name;

-- ── 2. INSERT — σύνδεση όλων των 4 ατόμων με όλες τις υπηρεσίες ──────────
insert into public.staff_services (clinic_id, staff_id, service_id)
select p.clinic_id, p.id, s.id
from public.profiles p
cross join public.services s
where p.clinic_id = (select id from public.clinics where name ilike '%beauty line%')
and s.clinic_id = p.clinic_id
and (
  unaccent(p.full_name) ilike unaccent('%λινα%') or
  unaccent(p.full_name) ilike unaccent('%χριστιαν%') or
  unaccent(p.full_name) ilike unaccent('%αθανασ%') or
  unaccent(p.full_name) ilike unaccent('%νανσ%')
)
and not exists (
  select 1 from public.staff_services ss where ss.staff_id = p.id and ss.service_id = s.id
);

-- ── 3. VERIFY — πλήθος υπηρεσιών ανά άτομο μετά την ανάθεση ──────────────
select p.full_name, count(ss.id) as αριθμος_υπηρεσιων
from public.profiles p
left join public.staff_services ss on ss.staff_id = p.id
where p.clinic_id = (select id from public.clinics where name ilike '%beauty line%')
group by p.full_name
order by p.full_name;
