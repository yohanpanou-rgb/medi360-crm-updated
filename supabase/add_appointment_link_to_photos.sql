-- Σύνδεση φωτογραφιών ασθενή με ραντεβού: η ετικέτα κάθε φωτογραφίας δείχνει
-- την ημερομηνία & υπηρεσία του ραντεβού (τεκμηρίωση before/after ανά θεραπεία).
-- Νέες φωτογραφίες συνδέονται αυτόματα με το ραντεβού της ίδιας ημέρας.
-- Run once στο Supabase SQL Editor ΠΡΙΝ γίνει deploy το σχετικό PR.

alter table public.patient_photos
  add column if not exists appointment_id uuid references public.appointments(id) on delete set null;
create index if not exists patient_photos_appointment_id_idx on public.patient_photos(appointment_id);
