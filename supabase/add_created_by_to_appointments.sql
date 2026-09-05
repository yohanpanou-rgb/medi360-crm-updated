-- 👤 Προσθήκη στήλης 'created_by' στον πίνακα appointments — ώστε να ξέρουμε
-- ΠΟΙΟΣ κατέγραψε χειροκίνητα ένα ραντεβού στο CRM, όχι μόνο πότε (created_at).
-- Μέχρι τώρα δεν υπήρχε πουθενά αυτή η πληροφορία (ούτε καν στον άδειο πίνακα
-- activity_log), οπότε είναι αδύνατο να το βρούμε αναδρομικά για ραντεβού που
-- υπάρχουν ήδη — η στήλη μένει NULL για αυτά.
--
-- NULL σημαίνει είτε: (α) παλιό ραντεβού πριν από αυτή την αλλαγή, είτε
-- (β) δημιουργήθηκε αυτόματα από το booking247-ingest (service-role insert,
-- χωρίς συνδεδεμένο χρήστη CRM — σωστά NULL, όχι bug).
--
-- Run once στο SQL Editor.

alter table public.appointments add column if not exists created_by uuid references public.profiles(id);
