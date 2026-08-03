-- Προσθέτει 8 ακόμη θεραπείες προσώπου (επιβεβαιωμένες από το επίσημο booking247.gr)
-- και διορθώνει το όνομα της Οξυγονοθεραπείας ώστε να συμπεριλαμβάνει το "Σουαλένιο".

-- ── 1. PREVIEW — δες την τρέχουσα λίστα πριν αλλάξει τίποτα ──────────────
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
      where v <> 'Οξυγονοθεραπεία με Βιταμίνες A, C, E'
      union all
      select x
      from jsonb_array_elements_text('[
        "Οξυγονοθεραπεία με Βιταμίνες A,C,E, Σουαλένιο",
        "Υδροδερμοαπόξεση",
        "Μεσοθεραπεία με Dermapen",
        "Δερμοαπόξεση με Διαμάντι",
        "Συσφικτική Θεραπεία με Facelift",
        "Φωτοθεραπεία για Ακμή, Ρυτίδες και Ευαίσθητο Δέρμα",
        "Μεσοθεραπεία Ματιών",
        "Θεραπεία Μαύρου Άνθρακα",
        "NanoPeel & Φωτοθεραπεία για Ακμή και Αντιγήρανση"
      ]'::jsonb) as x
    ) t
  )
)
where name ilike '%beauty line%';

-- ── 3. VERIFY — η νέα πλήρης λίστα ────────────────────────────────────────
select id, name, settings->'consultation_services' as updated_list
from public.clinics
where name ilike '%beauty line%';
