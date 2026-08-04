-- Μέρη σώματος πακέτου: μια Φόρμα Laser μπορεί να έχει ΠΟΛΛΑ πακέτα (π.χ.
-- "bikini" και "Laser Πρόσωπο x6") — το καθένα χρεώνεται μόνο από τις
-- συνεδρίες των δικών του περιοχών στους Πίνακες Θεραπείας.
-- Run once στο Supabase SQL Editor ΠΡΙΝ γίνει deploy το σχετικό PR.

alter table public.patient_packages
  add column if not exists body_parts text[];
