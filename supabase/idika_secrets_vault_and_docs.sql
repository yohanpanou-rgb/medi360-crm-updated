-- ΗΔΙΚΑ (Ηλεκτρονική Συνταγογράφηση) — εφαρμόστηκε στο production 26/09/2026
-- (migration "idika_secrets_vault_and_docs").
--
-- (1) Διαπιστευτήρια API Ιατρών στο Supabase Vault, με ανάγνωση ΜΟΝΟ από service_role
--     μέσω της rpc public.get_integration_secret. Οι Edge Functions (idika-prescriptions)
--     τα διαβάζουν από εκεί όταν δεν υπάρχουν ως env secrets. Τα ίδια τα secrets
--     γράφονται με: select vault.create_secret('<τιμή>', 'IDIKA_API_KEY' | 'IDIKA_USER' | 'IDIKA_PASS');
-- (2) Πίνακας εργασίας integrations.idika_docs για την τεκμηρίωση/OpenAPI του API
--     (κατεβασμένη μέσω idika-probe), ώστε να ερωτάται με jsonb από SQL.
create schema if not exists integrations;
revoke all on schema integrations from public, anon, authenticated;

create or replace function public.get_integration_secret(p_name text)
returns text
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare v text;
begin
  -- Μόνο service_role (Edge Functions). Κανένας client ρόλος δεν μπορεί να το καλέσει.
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role'
     and current_user not in ('postgres', 'service_role') then
    raise exception 'not allowed';
  end if;
  select decrypted_secret into v from vault.decrypted_secrets where name = p_name order by created_at desc limit 1;
  return v;
end $$;
revoke all on function public.get_integration_secret(text) from public, anon, authenticated;
grant execute on function public.get_integration_secret(text) to service_role;

create table if not exists integrations.idika_docs (
  id bigserial primary key,
  label text not null,
  url text,
  fetched_at timestamptz not null default now(),
  body text
);
revoke all on integrations.idika_docs from public, anon, authenticated;
