-- Κοστολόγηση υπηρεσιών: λίστα αναλώσιμων ανά υπηρεσία.
-- Κάθε στοιχείο: {"name": "Αμπούλα βιταμίνης C", "cost": 3.5}
-- Το συνολικό κόστος υπηρεσίας = Σ(αναλώσιμα) + (διάρκεια/60) × μέσο κόστος
-- εργατοώρας (αποθηκεύεται στο clinics.settings.hourly_opex — χωρίς migration).
--
-- Τρέξε το ΜΙΑ φορά στο SQL Editor.

alter table public.services
  add column if not exists consumables jsonb not null default '[]'::jsonb;
