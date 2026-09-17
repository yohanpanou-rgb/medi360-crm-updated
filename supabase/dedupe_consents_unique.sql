-- Εφαρμόστηκε ως migration `dedupe_consents_unique`.
--
-- Μία συναίνεση ανά ασθενή & ομάδα (service_consents) και μία laser συναίνεση ανά
-- ασθενή (laser_consents). Τα διπλά προέκυψαν από πολλαπλό πάτημα του «Υπογραφή &
-- Αποθήκευση» (ίδια υπογραφή μέσα σε δευτερόλεπτα). Κρατάμε την πιο πρόσφατη.
delete from public.service_consents s
using public.service_consents k
where k.patient_id = s.patient_id and k.consent_group is not distinct from s.consent_group
  and (k.signed_at > s.signed_at or (k.signed_at = s.signed_at and k.id > s.id));

delete from public.laser_consents s
using public.laser_consents k
where k.patient_id = s.patient_id
  and (k.signed_at > s.signed_at or (k.signed_at = s.signed_at and k.id > s.id));

-- Από εδώ και πέρα η βάση δεν δέχεται δεύτερη εγγραφή· η εφαρμογή κάνει upsert
-- (νέα υπογραφή = ανανέωση της υπάρχουσας, όχι δεύτερη γραμμή).
create unique index if not exists service_consents_patient_group_uniq on public.service_consents (patient_id, consent_group);
create unique index if not exists laser_consents_patient_uniq on public.laser_consents (patient_id);
