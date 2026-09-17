-- Κρίσιμη πληροφορία πελάτη — εφαρμόστηκε ως migration `add_patient_critical_info`.
-- critical_note: ελεύθερο κείμενο που βλέπει όποιος ανοίγει την καρτέλα ή το ραντεβού
-- (banner στην καρτέλα και στο popup ραντεβού, ‼ στην κάρτα Προγράμματος και στο tooltip,
-- pop-up μία φορά ανά άνοιγμα καρτέλας). arrives_late: χειροκίνητη σήμανση.
-- Η ένδειξη «ακυρώνει συχνά» υπολογίζεται αυτόματα από τα ραντεβού (index.html,
-- FREQUENT_CANCEL_RULE: 3+ ακυρώσεις/no-show σε 12 μήνες και >=20% των ραντεβού).
alter table public.patients add column if not exists critical_note text;
alter table public.patients add column if not exists arrives_late boolean not null default false;
