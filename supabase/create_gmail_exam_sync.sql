-- 📥 Προγραμματισμός: αυτόματη εισαγωγή εξετάσεων από emails πελατών κάθε
-- 15 λεπτά (βλ. supabase/functions/gmail-exam-sync/index.ts για τη λογική).
--
-- Πριν το τρέξεις, αντικατέστησε το REPLACE_WITH_SECRET με το ίδιο μυστικό
-- που χρησιμοποιείς ήδη στα υπόλοιπα cron jobs (BIRTHDAY_CRON_SECRET).
-- Run once στο SQL Editor.

select cron.schedule(
  'gmail-exam-sync-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://kfidxwqgsaisbdgucsok.supabase.co/functions/v1/gmail-exam-sync',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "REPLACE_WITH_SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
