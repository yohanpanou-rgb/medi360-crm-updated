-- 🏥 Προσθήκη στήλης 'city' στον πίνακα clinics — έλειπε από τη βάση ενώ
-- η φόρμα "Νέα Κλινική" στο CRM στέλνει πάντα αυτό το πεδίο, με αποτέλεσμα
-- το σφάλμα "Could not find the 'city' column of 'clinics' in the schema
-- cache" κατά την αποθήκευση.
--
-- Run once στο SQL Editor.

alter table public.clinics add column if not exists city text;
