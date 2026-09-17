-- activity_log: το RLS ήταν ενεργό ΧΩΡΙΣ policy, άρα το CRM δεν μπορούσε να
-- διαβάσει τίποτα (μόνο ο service role έγραφε). Χρειάζεται ανάγνωση για να
-- φαίνεται στην καρτέλα ασθενή ότι εξετάσεις από email «περιμένουν» την
-- υπογραφή GDPR (event_type = 'exam_blocked_no_gdpr', από το exam-ingest).
-- Μόνο SELECT, μόνο για τη δική σου κλινική (ή super admin).
drop policy if exists "activity_log_select_own_clinic" on public.activity_log;
create policy "activity_log_select_own_clinic" on public.activity_log
  for select to authenticated
  using (public.is_super_admin() or clinic_id = public.current_user_clinic_id());
