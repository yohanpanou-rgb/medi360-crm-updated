-- Σύσταση πελάτη — εφαρμόστηκε ως migration `add_patient_referrer`.
--
-- • referred_by_name: το ονοματεπώνυμο που γράφει ο ασθενής στη Φόρμα Ιστορικού
--   («Ποιος σας σύστησε;») όταν επιλέγει πηγή «Σύσταση» (ή η γραμματεία στην Επεξεργασία).
-- • referred_by_patient_id: σύνδεσμος στην καρτέλα του ασθενή που έκανε τη σύσταση,
--   όταν το όνομα ταυτοποιείται μονοσήμαντα με υπάρχοντα ασθενή της ίδιας κλινικής.
--   Στην καρτέλα του συστήνοντος εμφανίζεται η λίστα «Συστάσεις» (συνδεδεμένοι +
--   όσοι έγραψαν το όνομά του στη φόρμα).
alter table public.patients add column if not exists referred_by_name text;
alter table public.patients add column if not exists referred_by_patient_id uuid references public.patients(id) on delete set null;
create index if not exists patients_referred_by_patient_idx on public.patients (referred_by_patient_id) where referred_by_patient_id is not null;
