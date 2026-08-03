-- Καθαρισμός της λίστας Consulting μετά τα τελευταία προσθήκες:
-- 1) Ενοποιεί το Peeling (ήταν ακόμα 3 ξεχωριστά: Χημικό/Φυτικό/Απολέπισης)
-- 2) Αφαιρεί τα διπλότυπα Φωτοθεραπείας/NanoPeel που προέκυψαν από διαφορετικά
--    κεφαλαία/σύμβολα ανάμεσα σε παλιά και νέα εγγραφή, κρατώντας την ακριβή
--    ονομασία όπως είναι στο επίσημο booking247.

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
      where v not in (
        'Peeling Χημικό', 'Peeling Φυτικό', 'Peeling Απολέπισης',
        'Nanopeel & Φωτοθεραπεία για Ακμή και Αντιγήρανση',
        'Φωτοθεραπεία για ακμή, ρυτίδες & ευαίσθητο δέρμα',
        'Φωτοθεραπεία για Ακμή, Ρυτίδες και Ευαίσθητο Δέρμα'
      )
      union all
      select x
      from jsonb_array_elements_text('[
        "Peeling: Χημικό, Φυτικό, Απολέπισης",
        "NanoPeel & Φωτοθεραπεία για Ακμή και Αντιγήρανση",
        "Φωτοθεραπεία για ακμή, ρυτίδες και ευαίσθητο δέρμα"
      ]'::jsonb) as x
    ) t
  )
)
where name ilike '%beauty line%';

-- ── 3. VERIFY ──────────────────────────────────────────────────────────
select id, name, settings->'consultation_services' as updated_list
from public.clinics
where name ilike '%beauty line%';
