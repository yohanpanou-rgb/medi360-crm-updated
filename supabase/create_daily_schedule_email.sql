-- 📋 Βραδινό email προγράμματος: κάθε βράδυ στις 17:00 UTC (20:00 Ελλάδας το
-- καλοκαίρι λόγω θερινής ώρας — 19:00 τον χειμώνα, καθώς το pg_cron τρέχει σε
-- UTC χωρίς αυτόματη προσαρμογή DST) καλείται το daily-schedule-email edge
-- function, που στέλνει στο yourbeautyline@gmail.com το πρόγραμμα της επόμενης
-- ημέρας που έχει ραντεβού (πιάνει σωστά Κυριακές/αργίες/Δευτέρες-εξαίρεση).
--
-- Πριν το τρέξεις: αντικατέστησε το REPLACE_WITH_SECRET με την τιμή του
-- BIRTHDAY_CRON_SECRET (το κοινό secret των cron functions).
-- Τρέξε το ΜΙΑ φορά στο SQL Editor.

select cron.schedule(
  'daily-schedule-email',
  '0 17 * * *',
  $$
  select net.http_post(
    url := 'https://kfidxwqgsaisbdgucsok.supabase.co/functions/v1/daily-schedule-email',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "REPLACE_WITH_SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
