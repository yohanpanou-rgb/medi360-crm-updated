-- 📋 Καθημερινή Αναφορά Ελέγχου Ραντεβού & Πελατών — η ώρα αποστολής είναι
-- ρυθμιζόμενη ΑΝΑ ΚΛΙΝΙΚΗ (clinics.settings.daily_audit.send_time, ώρα
-- Ελλάδας, βήμα 15 λεπτών) αντί για μία σταθερή ώρα. Επειδή το pg_cron
-- τρέχει σε UTC χωρίς αυτόματη προσαρμογή θερινής/χειμερινής ώρας, δεν
-- μπορούμε να προσχεδιάσουμε το σωστό UTC ωράριο μία φορά — αντ' αυτού
-- καλούμε το daily-audit-report edge function ΚΑΘΕ 15 ΛΕΠΤΑ· το ίδιο το
-- function υπολογίζει σε κάθε κλήση την πραγματική τοπική ώρα Ελλάδας,
-- τη στρογγυλοποιεί σε 15λεπτο, και τη συγκρίνει με το ρυθμισμένο
-- send_time κάθε κλινικής — στέλνει μόνο όταν ταιριάζουν. Έτσι λειτουργεί
-- σωστά ανεξάρτητα από DST και υποστηρίζει διαφορετική ώρα ανά κλινική.
--
-- Πριν το τρέξεις: αντικατέστησε το REPLACE_WITH_SECRET με την τιμή του
-- BIRTHDAY_CRON_SECRET (το κοινό secret των cron functions).
-- Τρέξε το ΜΙΑ φορά στο SQL Editor.

select cron.schedule(
  'daily-audit-report',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://kfidxwqgsaisbdgucsok.supabase.co/functions/v1/daily-audit-report',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "REPLACE_WITH_SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
