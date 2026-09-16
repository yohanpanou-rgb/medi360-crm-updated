-- Η στήλη «ΗΜ/ΝΙΑ» στο SMS Log έδειχνε «—» σε ΟΛΕΣ τις εγγραφές.
--
-- Αιτία: το sms_log.sent_at δεν έχει default και το edge function
-- (appointment-automations → logSms) δεν το περνάει στο insert, οπότε έμενε
-- πάντα NULL. Επιπλέον η λίστα ταξινομούνταν σε αυτή ακριβώς τη στήλη
-- (order by sent_at), γι' αυτό οι εγγραφές έβγαιναν και σε τυχαία σειρά.
--
-- Το default now() το διορθώνει για κάθε μελλοντική εγγραφή ΧΩΡΙΣ redeploy του
-- edge function, και δουλεύει ακόμα κι αν γράψει κάποιος στον πίνακα από αλλού.
alter table sms_log alter column sent_at set default now();

-- Ιστορικές εγγραφές: η ώρα καταγραφής ισούται πρακτικά με την ώρα αποστολής
-- (το insert γίνεται αμέσως μετά την κλήση του παρόχου).
update sms_log set sent_at = created_at where sent_at is null;
