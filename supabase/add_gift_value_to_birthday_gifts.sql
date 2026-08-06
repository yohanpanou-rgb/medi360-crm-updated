-- Αξία δώρου γενεθλίων ΑΝΑ δώρο: η αξία «κλειδώνει» τη στιγμή που δίνεται.
-- Έτσι η αλλαγή του ποσού (80€ → 60€ από 06/08/2026) δεν επηρεάζει όσους
-- έχουν ήδη λάβει email με την παλιά υπόσχεση — η καρτέλα τους συνεχίζει
-- να δείχνει 80€ μέχρι τη λήξη/εξαργύρωση του δώρου τους.
--
-- Τρέξε το ΜΙΑ φορά στο SQL Editor, ΠΡΙΝ γίνει redeploy το birthday-emails.

alter table public.birthday_gifts
  add column if not exists gift_value numeric not null default 60;

-- Όλα τα δώρα που δόθηκαν πριν την αλλαγή είχαν υποσχεθεί 80€
update public.birthday_gifts set gift_value = 80;
