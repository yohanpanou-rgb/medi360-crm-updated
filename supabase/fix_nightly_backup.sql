-- Διόρθωση nightly backup (jobid 3).
--
-- Το παλιό cron command ήταν ένα ενιαίο μπλοκ SQL που ανέφερε τον πίνακα
-- public.consultations, ο οποίος ΔΕΝ υπάρχει στη βάση. Έσκαγε στην τρίτη
-- γραμμή, οπότε δεν γραφόταν κανένας πίνακας — ούτε καν όσοι προηγούνταν:
--
--   ERROR: relation "public.consultations" does not exist
--
-- Αποτέλεσμα: 74 εκτελέσεις από 05/07/2026, 0 επιτυχίες. Δεν υπήρξε ποτέ
-- αντίγραφο ασφαλείας. Το ίδιο το σχήμα backup δεν είχε καν δημιουργηθεί.
--
-- Τι αλλάζει:
--  1. Ο κατάλογος πινάκων διαβάζεται από το pg_class αντί να είναι γραμμένος
--     στο χέρι — δεν μπορεί να μείνει πίσω ούτε να αναφέρει ανύπαρκτο πίνακα.
--  2. Κάθε πίνακας σε δικό του exception block — ένας προβληματικός πίνακας
--     δεν ρίχνει ολόκληρο το backup (αυτό ακριβώς ήταν το σφάλμα).
--  3. Δύο γενιές: _snap (τελευταίο) και _prev (προηγούμενο), ώστε να υπάρχει
--     περιθώριο ανάκτησης αν το λάθος δεν εντοπιστεί την ίδια μέρα.
--  4. Κάθε εκτέλεση καταγράφεται στο backup.runs.
--
-- ΠΡΟΣΟΧΗ: τα snapshots ζουν στην ΙΔΙΑ βάση. Προστατεύουν από λάθος διαγραφή
-- ή αλλοίωση δεδομένων μέσα από την εφαρμογή — ΟΧΙ από απώλεια της βάσης.
-- Για εκείνο χρειάζονται τα backups της πλατφόρμας Supabase.

create schema if not exists backup;

create table if not exists backup.runs (
  id            bigserial primary key,
  taken_at      timestamptz not null default now(),
  tables_ok     int not null default 0,
  tables_failed int not null default 0,
  detail        jsonb
);

create or replace function backup.take_snapshot()
returns jsonb
language plpgsql
security definer
set search_path to 'public','backup','pg_temp'
as $fn$
declare
  t        record;
  ok_list  text[] := '{}';
  err_list text[] := '{}';
  result   jsonb;
begin
  for t in
    select c.relname as tbl
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  loop
    begin
      execute format('drop table if exists backup.%I', t.tbl || '_prev');
      if to_regclass('backup.' || quote_ident(t.tbl || '_snap')) is not null then
        execute format('alter table backup.%I rename to %I', t.tbl || '_snap', t.tbl || '_prev');
      end if;
      execute format('create table backup.%I as select * from public.%I', t.tbl || '_snap', t.tbl);
      ok_list := ok_list || t.tbl;
    exception when others then
      err_list := err_list || (t.tbl || ': ' || sqlerrm);
    end;
  end loop;

  result := jsonb_build_object('taken_at', now(), 'ok', to_jsonb(ok_list), 'failed', to_jsonb(err_list));

  insert into backup.runs (tables_ok, tables_failed, detail)
  values (coalesce(array_length(ok_list,1),0), coalesce(array_length(err_list,1),0), result);

  return result;
end
$fn$;

revoke all on function backup.take_snapshot() from public, anon, authenticated;

-- Το cron job δείχνει πλέον στη function:
--   select cron.alter_job(3, command := 'select backup.take_snapshot();');

-- Έλεγχος ότι δουλεύει:
--   select tables_ok, tables_failed, taken_at from backup.runs order by id desc limit 5;
