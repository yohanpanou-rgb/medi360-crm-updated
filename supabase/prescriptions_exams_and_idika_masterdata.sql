-- Ηλεκτρονική Συνταγογράφηση (ΗΔΙΚΑ) — Παραπεμπτικά εξετάσεων + λίστες (masterdata) ΗΔΙΚΑ.
-- Εφαρμόστηκε στο production στις 26/09/2026 (migration "prescriptions_exams_and_idika_masterdata").
--
-- (1) Η ίδια οντότητα «Συνταγή» (public.prescriptions) αποκτά ΕΙΔΟΣ: 'medicines' (συνταγή
--     φαρμάκων, ό,τι υπήρχε) ή 'exams' (παραπεμπτικό εξετάσεων). Το παραπεμπτικό κρατά τις
--     εξετάσεις που επιλέχθηκαν από τον κατάλογο της ΗΔΙΚΑ και τον λόγο παραπομπής.
alter table public.prescriptions
  add column if not exists kind text not null default 'medicines' check (kind in ('medicines','exams')),
  add column if not exists examinations jsonb not null default '[]'::jsonb,   -- [{id, code, name, group}]  (id = ΗΔΙΚΑ examination id)
  add column if not exists referral_reason text;                              -- diagnosis | followup | preventive | preop

-- (2) Τοπικά αντίγραφα των masterdata του API Ιατρών (GET /api/v1/masterdata/examinations,
--     /api/v1/masterdata/icd10s). Τα γεμίζει η Edge Function idika-prescriptions
--     (action 'sync_masterdata') με service_role· οι χρήστες μόνο διαβάζουν (αναζήτηση
--     εξετάσεων στο παραπεμπτικό, κωδικοί ICD-10). Κοινά για όλες τις κλινικές — δεν είναι
--     δεδομένα ασθενών.
create table if not exists public.idika_examinations (
  id integer primary key,                 -- examination id ΗΔΙΚΑ
  code text,                              -- codeEdapi
  description text not null,
  keywords text,
  group_id integer,
  group_name text,
  subgroup_name text,
  active boolean not null default true,
  is_high_cost boolean default false,
  raw jsonb,
  synced_at timestamptz not null default now()
);
create index if not exists idika_examinations_desc_idx on public.idika_examinations using gin (to_tsvector('simple', coalesce(description,'') || ' ' || coalesce(keywords,'')));

create table if not exists public.idika_icd10s (
  id integer primary key,
  code text not null,
  title text not null,
  description text,
  active boolean not null default true,   -- false όταν η ΗΔΙΚΑ δίνει endDate (ληγμένος κωδικός)
  only_by_protocol boolean default false,
  raw jsonb,
  synced_at timestamptz not null default now()
);
create index if not exists idika_icd10s_code_idx on public.idika_icd10s (code);

create table if not exists public.idika_sync_log (
  id bigserial primary key,
  dataset text not null,                  -- examinations | icd10s
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows integer not null default 0,
  ok boolean,
  error text
);

alter table public.idika_examinations enable row level security;
alter table public.idika_icd10s enable row level security;
alter table public.idika_sync_log enable row level security;
drop policy if exists idika_examinations_read on public.idika_examinations;
create policy idika_examinations_read on public.idika_examinations for select to authenticated using (true);
drop policy if exists idika_icd10s_read on public.idika_icd10s;
create policy idika_icd10s_read on public.idika_icd10s for select to authenticated using (true);
drop policy if exists idika_sync_log_read on public.idika_sync_log;
create policy idika_sync_log_read on public.idika_sync_log for select to authenticated using (true);
-- Μόνο ανάγνωση από τους clients· γράφει αποκλειστικά η Edge Function (service_role).
revoke insert, update, delete, truncate, references, trigger on public.idika_examinations, public.idika_icd10s, public.idika_sync_log from anon, authenticated;
revoke select on public.idika_examinations, public.idika_icd10s, public.idika_sync_log from anon;

-- (3) Αναζήτηση εξετάσεων για το παραπεμπτικό: χωρίς τόνους / πεζά-κεφαλαία (unaccent),
--     όλες οι λέξεις του ερωτήματος πρέπει να υπάρχουν σε περιγραφή/λέξεις-κλειδιά/κωδικό.
--     Καλείται από το frontend: sb.rpc('search_idika_examinations', {p_q, p_limit}).
create or replace function public.search_idika_examinations(p_q text, p_limit integer default 12)
returns table (id integer, code text, description text, group_name text)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with toks as (
    select unaccent(lower(t)) t from regexp_split_to_table(coalesce(p_q,''), '\s+') t where length(t) >= 1
  )
  select e.id, e.code, e.description, e.group_name
  from public.idika_examinations e
  where e.active
    and not exists (
      select 1 from toks
      where unaccent(lower(coalesce(e.description,'') || ' ' || coalesce(e.keywords,'') || ' ' || coalesce(e.code,''))) not like '%' || toks.t || '%'
    )
  order by (unaccent(lower(e.description)) like unaccent(lower(coalesce(p_q,''))) || '%') desc, e.description
  limit greatest(1, least(coalesce(p_limit,12), 50));
$$;
revoke all on function public.search_idika_examinations(text, integer) from public, anon;
grant execute on function public.search_idika_examinations(text, integer) to authenticated, service_role;
