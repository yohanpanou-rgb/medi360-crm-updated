-- 🔧 ΔΙΟΡΘΩΣΗ: το check constraint της appointments.status δεν επέτρεπε το
-- νέο status 'booked' (ΚΛΕΙΣΜΕΝΟ) που προστέθηκε στο appointment-automations
-- σύστημα (PR #98) — κάθε νέο ραντεβού >48 ώρες μπροστά (από το CRM ή από
-- Booking247) απέτυχε να αποθηκευτεί μέχρι να τρέξει αυτό.
--
-- Τρέξε το ΜΙΑ φορά στο SQL Editor (ασφαλές να ξανατρέξει).

alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status in ('booked','confirmed','in_progress','completed','cancelled','no_show'));
