-- Προσθήκη νέου status 'rescheduled' (Μεταφέρθηκε) στο appointments.status —
-- υποστηρίζει τη λειτουργία μεταφοράς ραντεβού σε άλλη ημέρα/ώρα από το
-- dropdown κατάστασης στο index.html (βλ. apptStatusUpdatePayload /
-- openRescheduleApptPicker). Τρέξε το ΜΙΑ φορά στο SQL Editor (ασφαλές να
-- ξανατρέξει).

alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status in ('booked','confirmed','in_progress','completed','cancelled','no_show','rescheduled'));
