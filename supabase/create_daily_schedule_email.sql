-- 📋 Βραδινό email προγράμματος: στέλνεται ΠΑΝΤΑ στις 20:00 ώρα Ελλάδας, και
-- το καλοκαίρι (θερινή ώρα) και τον χειμώνα. Το pg_cron τρέχει σε UTC χωρίς
-- αυτόματη προσαρμογή θερινής/χειμερινής ώρας, οπότε καλούμε το
-- daily-schedule-email edge function ΔΥΟ φορές την ημέρα — 17:00 UTC
-- (=20:00 EEST καλοκαίρι) ΚΑΙ 18:00 UTC (=20:00 EET χειμώνα)· το ίδιο το
-- function ελέγχει την πραγματική τοπική ώρα Ελλάδας και εκτελείται μόνο σε
-- όποια από τις δύο κλήσεις πέφτει ΠΡΑΓΜΑΤΙΚΑ στις 20:00 εκεί — η άλλη γυρνάει
-- αμέσως χωρίς να στείλει τίποτα. Έτσι δεν χρειάζεται καμία χειροκίνητη
-- αλλαγή δύο φορές τον χρόνο στις ημερομηνίες αλλαγής ώρας.
--
-- Στέλνει στο yourbeautyline@gmail.com το πρόγραμμα της επόμενης ημέρας που
-- έχει ραντεβού (πιάνει σωστά Κυριακές/αργίες/Δευτέρες-εξαίρεση).
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

select cron.schedule(
  'daily-schedule-email-winter',
  '0 18 * * *',
  $$
  select net.http_post(
    url := 'https://kfidxwqgsaisbdgucsok.supabase.co/functions/v1/daily-schedule-email',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "REPLACE_WITH_SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
