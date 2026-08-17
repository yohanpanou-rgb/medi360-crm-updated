-- 🩺 Καθάρισμα του προηγούμενου (λάθος αρχιτεκτονικά) gmail-exam-sync και
-- σημείωση ρύθμισης του νέου exam-ingest — αντικαθιστά το OAuth-based
-- polling με το ίδιο μοτίβο Apps Script → ingest endpoint που ήδη
-- χρησιμοποιεί το booking247-ingest (δεν λήγει ποτέ, βλ. σχόλια στο
-- google-apps-script/booking247-sync.gs).
--
-- Run once στο SQL Editor.

-- Το gmail-exam-sync-15min δείχνει πλέον σε function που δεν υπάρχει πια —
-- ασφαλές να τρέξει ακόμα κι αν το job είχε ήδη διαγραφεί/δεν υπάρχει.
select cron.unschedule('gmail-exam-sync-15min')
where exists (select 1 from cron.job where jobname = 'gmail-exam-sync-15min');

-- Δεν χρειάζεται νέο cron.schedule εδώ — το exam-ingest δεν σαρώνει τίποτα
-- μόνο του, απλά δέχεται ό,τι του στέλνει το Apps Script (δες
-- syncExamAttachments στο .gs αρχείο, τρέχει μόνο του κάθε 5 λεπτά μέσα στο
-- Google Apps Script, όχι εδώ).
