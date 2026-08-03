-- Προσθέτει νέες θεραπείες προσώπου στη λίστα του Consulting (Ρυθμίσεις →
-- clinics.settings.consultation_services) — αυτή είναι η λίστα που τροφοδοτεί
-- το dropdown στα Βήματα 1-3 της Φόρμας Consultation.
--
-- Ασφαλές: ΔΕΝ σβήνει τις υπάρχουσες θεραπείες, μόνο προσθέτει τις νέες
-- (και αγνοεί σιωπηλά όποια από τις νέες υπάρχει ήδη — χωρίς διπλότυπα).

-- ── 1. PREVIEW — δες την τρέχουσα λίστα πριν αλλάξει τίποτα ──────────────
select id, name, settings->'consultation_services' as current_list
from public.clinics
where name ilike '%beauty line%';

-- ── 2. UPDATE — προσθήκη των νέων θεραπειών ──────────────────────────────
update public.clinics
set settings = jsonb_set(
  coalesce(settings, '{}'::jsonb),
  '{consultation_services}',
  (
    select jsonb_agg(distinct v)
    from jsonb_array_elements_text(
      coalesce(settings->'consultation_services', '[]'::jsonb)
      || '[
        "Peeling Χημικό",
        "Peeling Φυτικό",
        "Peeling Απολέπισης",
        "Θεραπεία Ματιών",
        "Αντιγήρανση με Οξέα Φρούτων (AHAs)",
        "Οξυγονοθεραπεία με Βιταμίνες A, C, E",
        "Ενυδάτωση με Υπερήχους και Υ/Ο",
        "Ενυδάτωση Flash για Κανονικό & Μεικτό Δέρμα",
        "Θεραπεία με Εστέρα Ρετινόλης και Vit C",
        "Luminous Glow",
        "Ενυδάτωση με Υπερήχους, Βιταμίνες και Nanopeel",
        "Smart Peeling T33",
        "Retinal Shine by Medik8",
        "Sun Repair Καθαρισμός και Ενυδάτωση"
      ]'::jsonb
    ) as v
  )
)
where name ilike '%beauty line%';

-- ── 3. VERIFY — η νέα πλήρης λίστα ────────────────────────────────────────
select id, name, settings->'consultation_services' as updated_list
from public.clinics
where name ilike '%beauty line%';
