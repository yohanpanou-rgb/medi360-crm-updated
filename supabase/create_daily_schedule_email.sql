-- 📋 Βραδινό email προγράμματος: κάθε βράδυ στις 18:00 UTC (21:00 Ελλάδας το
-- καλοκαίρι, 20:00 τον χειμώνα) καλείται το daily-schedule-email edge function,
-- που στέλνει στο yourbeautyline@gmail.com το πρόγραμμα της επόμενης ημέρας
-- που έχει ραντεβού (πιάνει σωστά Κυριακές/αργίες/Δευτέρες-εξαίρεση).
--
-- Πριν το τρέξεις: αντικατέστησε το REPLACE_WITH_SECRET με την τιμή του
-- BIRTHDAY_CRON_SECRET (το κοινό secret των cron functions).
-- Τρέξε το ΜΙΑ φορά στο SQL Editor.

select cron.schedule(
  'daily-schedule-email',
  '0 18 * * *',
  $$
  select net.http_post(
    url := 'https://kfidxwqgsaisbdgucsok.supabase.co/functions/v1/daily-schedule-email',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "REPLACE_WITH_SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
