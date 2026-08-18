-- 🩺 Προσθήκη στήλης για τον πραγματικό λόγο αποτυχίας της AI ταξινόμησης
-- εξέτασης (π.χ. κλειδωμένο PDF, σφάλμα API) — πριν απλά έλεγε "failed"
-- χωρίς καμία εξήγηση, ούτε καν στα function logs.
--
-- Run once στο SQL Editor.

alter table public.patient_exams add column if not exists ai_error text;
