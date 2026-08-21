-- 🧾 myDATA ηλεκτρονική απόδειξη (μέσω Wrapp) — στήλες στο appointments για να
-- καταγράφεται τι εκδόθηκε πραγματικά (μπορεί να διαφέρει ελαφρώς από το
-- appointments.price αν το άλλαξε ο χρήστης στο popup έκδοσης).
--
-- Run once στο SQL Editor.

alter table public.appointments
  add column if not exists receipt_mark text,
  add column if not exists receipt_issued_at timestamptz,
  add column if not exists receipt_amount numeric,
  add column if not exists receipt_payment_method text,
  add column if not exists receipt_error text;
