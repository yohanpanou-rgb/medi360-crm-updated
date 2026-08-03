-- Σύνδεση Πακέτων Συνεδριών με τη Φόρμα Laser: το πακέτο δείχνει πλέον τις
-- πραγματικές καταγεγραμμένες συνεδρίες της φόρμας (ημερομηνία, μέρος σώματος,
-- ρυθμίσεις μηχανήματος: Spot Size / Ενέργεια / DCD), και η φόρμα δείχνει το
-- υπόλοιπο του πακέτου.

alter table public.patient_packages
  add column if not exists laser_form_id uuid references public.laser_forms(id) on delete set null;
create index if not exists patient_packages_laser_form_id_idx on public.patient_packages(laser_form_id);
