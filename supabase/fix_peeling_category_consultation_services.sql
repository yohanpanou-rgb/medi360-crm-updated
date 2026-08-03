-- Διόρθωση: το "Peeling : χημικά, φυτικά, απολέπισης" ήταν ΜΙΑ κατηγορία,
-- όχι 3 ξεχωριστές θεραπείες. Αφαιρεί τις 3 λανθασμένα διαχωρισμένες
-- καταχωρήσεις και τις αντικαθιστά με μία ενιαία.

-- ── 1. PREVIEW ─────────────────────────────────────────────────────────
select id, name, settings->'consultation_services' as current_list
from public.clinics
where name ilike '%beauty line%';

-- ── 2. UPDATE ──────────────────────────────────────────────────────────
update public.clinics
set settings = jsonb_set(
  coalesce(settings, '{}'::jsonb),
  '{consultation_services}',
  (
    select jsonb_agg(distinct v)
    from (
      select v
      from jsonb_array_elements_text(coalesce(settings->'consultation_services', '[]'::jsonb)) as v
      where v not in ('Peeling Χημικό', 'Peeling Φυτικό', 'Peeling Απολέπισης')
      union all
      select 'Peeling: Χημικό, Φυτικό, Απολέπισης'
    ) t
  )
)
where name ilike '%beauty line%';

-- ── 3. VERIFY ──────────────────────────────────────────────────────────
select id, name, settings->'consultation_services' as updated_list
from public.clinics
where name ilike '%beauty line%';
