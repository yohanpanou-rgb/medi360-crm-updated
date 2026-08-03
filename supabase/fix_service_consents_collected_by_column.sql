-- Το CRM αδυνατεί να αποθηκεύσει τη συναίνεση υπηρεσίας (π.χ. "Καθαρισμός
-- Προσώπου / Σώματος") επειδή στον πίνακα service_consents λείπει η στήλη
-- collected_by (και ενδεχομένως άλλες που χρησιμοποιεί ο κώδικας κατά την
-- αποθήκευση). Αυτό το script τις προσθέτει με ασφάλεια — δεν πειράζει
-- καθόλου υπάρχουσες εγγραφές.

alter table public.service_consents
  add column if not exists collected_by text,
  add column if not exists consent_version text default 'v1',
  add column if not exists photo_consent boolean default false;

-- ── VERIFY — δες τις στήλες του πίνακα μετά την αλλαγή ───────────────────
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'service_consents'
order by ordinal_position;
