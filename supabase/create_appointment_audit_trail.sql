-- Ιστορικό αλλαγών ραντεβού.
--
-- Πρόβλημα: δεν υπήρχε κανένα ίχνος του ποιος άλλαξε τι και πότε.
--   * 4.301 από 4.301 ραντεβού είχαν updated_at ΙΔΙΟ με created_at — κανένα
--     trigger δεν ενημέρωνε τη στήλη, οπότε ήταν απλώς αντίγραφο του created_at.
--   * Οι χειροκίνητες αλλαγές κατάστασης (π.χ. ακύρωση από το παράθυρο
--     ραντεβού) δεν γράφονταν πουθενά — μόνο οι ακυρώσεις που έκανε ο ΠΕΛΑΤΗΣ
--     από το link του email κατέληγαν στο communication_log.
--   * Ο πίνακας activity_log υπήρχε ήδη με σωστή δομή, αλλά ήταν εντελώς άδειος.
--
-- Έτσι, όταν ένα ραντεβού βρέθηκε ακυρωμένο, ήταν αδύνατο να απαντηθεί πότε και
-- από ποιον — και επομένως αν ένα αυτόματο email είχε φύγει σωστά ή λάθος.

-- 1) updated_at: σφραγίδα σε κάθε αλλαγή.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists appointments_touch_updated_at on public.appointments;
create trigger appointments_touch_updated_at
  before update on public.appointments
  for each row execute function public.touch_updated_at();

drop trigger if exists patients_touch_updated_at on public.patients;
create trigger patients_touch_updated_at
  before update on public.patients
  for each row execute function public.touch_updated_at();

-- 2) Καταγραφή αλλαγών κατάστασης και διαγραφών στο activity_log.
--
--    user_id = auth.uid() του συνδεδεμένου χρήστη. Όταν η αλλαγή γίνεται από
--    αυτοματισμό (edge function με service role) μένει NULL — που είναι η σωστή
--    απάντηση: δεν την έκανε άνθρωπος.
--
--    ΚΡΙΣΙΜΟ: όλη η καταγραφή είναι μέσα σε exception block. Ένα trigger
--    καταγραφής δεν επιτρέπεται ΠΟΤΕ να μπλοκάρει την πραγματική ενέργεια —
--    καλύτερα να χαθεί μια γραμμή ιστορικού παρά να μην μπορεί να ακυρωθεί
--    ένα ραντεβού.
create or replace function public.log_appointment_change()
returns trigger language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare
  uid uuid;
begin
  begin
    begin uid := auth.uid(); exception when others then uid := null; end;

    if tg_op = 'DELETE' then
      insert into activity_log (clinic_id, patient_id, user_id, event_type, event_data)
      values (old.clinic_id, old.patient_id, uid, 'appointment_deleted',
        jsonb_build_object(
          'appointment_id', old.id,
          'status_was',     old.status,
          'start_time',     old.start_time,
          'service_name',   old.service_name,
          'price',          old.price
        ));
    elsif new.status is distinct from old.status then
      insert into activity_log (clinic_id, patient_id, user_id, event_type, event_data)
      values (new.clinic_id, new.patient_id, uid, 'appointment_status_changed',
        jsonb_build_object(
          'appointment_id', new.id,
          'from',           old.status,
          'to',             new.status,
          'start_time',     new.start_time,
          'service_name',   new.service_name
        ));
    end if;
  exception when others then
    null; -- best effort
  end;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists appointments_log_change on public.appointments;
create trigger appointments_log_change
  after update or delete on public.appointments
  for each row execute function public.log_appointment_change();

create index if not exists activity_log_clinic_created_idx
  on public.activity_log (clinic_id, created_at desc);
create index if not exists activity_log_event_idx
  on public.activity_log (event_type, created_at desc);

-- Παράδειγμα ερώτησης «ποιος ακύρωσε τι σήμερα»:
--   select a.created_at at time zone 'Europe/Athens' as pote,
--          coalesce(pr.full_name,'(αυτοματισμός)')   as poios,
--          p.full_name                                as pelatis,
--          a.event_data->>'from' || ' -> ' || (a.event_data->>'to') as allagi
--   from activity_log a
--   left join profiles pr on pr.id = a.user_id
--   left join patients p  on p.id  = a.patient_id
--   where a.event_type = 'appointment_status_changed'
--   order by a.created_at desc;
