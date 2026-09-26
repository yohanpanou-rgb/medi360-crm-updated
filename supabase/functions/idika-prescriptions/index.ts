// Supabase Edge Function — Ηλεκτρονική Συνταγογράφηση (ΗΔΙΚΑ, API Ιατρών) για το CRM.
//
// Οντότητα «Συνταγή» = πίνακας public.prescriptions, δύο είδη (kind):
//   medicines → συνταγή φαρμάκων (διαγνώσεις ICD-10 + σκευάσματα ΕΟΦ)
//   exams     → παραπεμπτικό εξετάσεων (διαγνώσεις ICD-10 + εξετάσεις ΗΔΙΚΑ + λόγος παραπομπής)
// Κύκλος ζωής: draft → sent → issued / error / cancelled. Αυτή η function είναι το ΜΟΝΟ
// σημείο που μιλά με το ΣΗΣ — το frontend δεν αγγίζει ποτέ κλειδιά/κωδικούς.
//
// Actions (POST, JSON):
//   { action:'status' }                        → ρυθμισμένη σύνδεση; περιβάλλον; μεγέθη masterdata
//   { action:'test' }                          → GET /api/v1/me (login + «ενεργή σύνδεση» 24ώρου)
//   { action:'send', prescription_id }         → έλεγχοι πληρότητας + προεπισκόπηση CDA + επιβεβαίωση
//                                                σύνδεσης. Η ΠΡΑΓΜΑΤΙΚΗ καταχώρηση (POST /api/v1/me/visits,
//                                                /me/prescriptions, /me/referrals) ενεργοποιείται μόλις ο
//                                                χρήστης αποκτήσει μονάδα συνταγογράφησης στο UAT.
//   { action:'sync_masterdata', dataset }      → 'examinations' | 'icd10s' → κατεβάζει τα masterdata της
//                                                ΗΔΙΚΑ στους πίνακες idika_examinations / idika_icd10s
//                                                (κοινοί για όλες τις κλινικές, μόνο ανάγνωση από το UI).
//
// Επιβεβαιωμένα στο UAT (26/09/2026): Basic auth χρήστη ΗΣ, application key στο header `api-key`,
// επιπλέον header X-DOCTOR-IP (εξωτερική IP του χρήστη — περνάμε την IP του καλούντος).
//
// Secrets: env IDIKA_API_KEY / IDIKA_USER / IDIKA_PASS ή Supabase Vault μέσω rpc
// public.get_integration_secret (μόνο service_role). Προαιρετικά IDIKA_BASE, IDIKA_KEY_HEADER.
// Auth κλήσης: JWT χρήστη (super_admin/clinic_admin, ή therapist με can_view_diagnosis)
// ή x-cron-secret = BIRTHDAY_CRON_SECRET (+ body.clinic_id) για δοκιμές.
// Deploy: supabase functions deploy idika-prescriptions --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const BASE = (Deno.env.get('IDIKA_BASE') || 'https://testeps.e-prescription.gr/docapiv2').replace(/\/$/, '');
const KEY_HEADER = Deno.env.get('IDIKA_KEY_HEADER') || 'api-key';
const ENV_LABEL = BASE.includes('testeps') || BASE.includes('test.') ? 'uat' : 'production';

// ── Διαπιστευτήρια: env → Vault ──
const SECRET_NAMES = ['IDIKA_API_KEY', 'IDIKA_USER', 'IDIKA_PASS'] as const;
const secretCache: Record<string, string> = {};
async function loadSecrets(admin: any) {
  for (const n of SECRET_NAMES) {
    if (secretCache[n]) continue;
    const env = Deno.env.get(n);
    if (env) { secretCache[n] = env; continue; }
    try {
      const { data } = await admin.rpc('get_integration_secret', { p_name: n });
      if (data) secretCache[n] = String(data);
    } catch (_) { /* χωρίς vault → μένει μη ρυθμισμένο */ }
  }
}
const configured = () => SECRET_NAMES.every(n => !!secretCache[n]);

let callerIp = '';
async function idikaFetch(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    Accept: 'application/xml, application/json;q=0.9, */*;q=0.5',
    Authorization: 'Basic ' + btoa(`${secretCache.IDIKA_USER}:${secretCache.IDIKA_PASS}`),
    [KEY_HEADER]: secretCache.IDIKA_API_KEY || '',
    ...(callerIp ? { 'X-DOCTOR-IP': callerIp } : {}),
    ...(init.headers as Record<string, string> || {}),
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(BASE + path, { ...init, headers, signal: ctrl.signal });
    const text = await r.text();
    return { status: r.status, text };
  } finally { clearTimeout(t); }
}

// ── Μικρά XML helpers (οι απαντήσεις της ΗΔΙΚΑ είναι XML) ──
const xmlTag = (xml: string, tag: string) => { const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)); return m ? m[1] : ''; };
const xmlUnesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xesc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
function xmlItems(xml: string): string[] {
  // Τα <item> του <contents> (χωρίς εμφωλευμένα item σε άλλα επίπεδα).
  const m = xml.match(/<contents>([\s\S]*)<\/contents>/);
  if (!m) return [];
  const out: string[] = []; const re = /<item>([\s\S]*?)<\/item>(?=\s*(?:<item>|<\/contents>))/g; let x;
  while ((x = re.exec(m[1]))) out.push(x[1]);
  return out;
}
const tagIn = (item: string, tag: string) => { const m = item.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)); return m ? xmlUnesc(m[1]) : ''; };

type Check = { key: string; label: string; ok: boolean; detail?: string };

// ── Προεπισκόπηση CDA (HL7 v3), προκαταρκτική — βασισμένη στο παράδειγμα CDA της ΗΔΙΚΑ:
// patientRole/id root 1.10.1 = ΑΜΚΑ, author ids 1.19 (ΑΜΚΑ ιατρού) / 1.19.1 (ειδικότητα),
// encompassingEncounter 1.80 (επίσκεψη) / 1.80.1 (μονάδα), διάγνωση ως observation με ICD10
// codeSystem 1.3.6.1.4.1.12559.11.10.1.3.1.44.2, σκευάσματα ως substanceAdministration με κωδικό ΕΟΦ.
function buildPreviewXml(p: any, patient: any, doctor: any) {
  const dob = patient?.dob ? String(patient.dob).replace(/-/g, '') : '';
  const gender = patient?.gender === 'male' ? 'M' : patient?.gender === 'female' ? 'F' : 'UN';
  const [given, ...rest] = String(patient?.full_name || '').trim().split(/\s+/);
  const family = rest.join(' ');
  const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const today = now.slice(0, 8);
  const isExams = p.kind === 'exams';
  const diag = (p.diagnoses || []).map((d: any) => `
        <entryRelationship typeCode="RSON">
          <observation classCode="OBS" moodCode="EVN">
            <templateId root="1.3.6.1.4.1.19376.1.5.3.1.4.5"/>
            <code code="282291009" codeSystem="1.3.6.1.4.1.12559.11.10.1.3.1.42.23" codeSystemName="SNOMED-CT" displayName="Diagnosis interpretation"/>
            <text>${xesc(d.name || '')}</text>
            <statusCode code="completed"/>
            <value xsi:type="CD" code="${xesc(d.icd10 || '')}" codeSystem="1.3.6.1.4.1.12559.11.10.1.3.1.44.2" codeSystemName="ICD10" displayName="${xesc(d.name || '')}"/>
          </observation>
        </entryRelationship>`).join('');
  const meds = (p.medicines || []).map((m: any, i: number) => `
      <entry>
        <substanceAdministration classCode="SBADM" moodCode="INT">
          <templateId root="1.3.6.1.4.1.12559.11.10.1.3.1.3.2"/>
          <id extension="${i + 1}" root="1.21.1"/>
          <statusCode code="active"/>
          <text>${xesc(m.dosage || '')}</text>
          <doseQuantity><low value="${xesc(m.quantity || 1)}"/><high value="${xesc(m.quantity || 1)}"/></doseQuantity>
          ${m.days ? `<rateQuantity><low value="${xesc(m.days)}" unit="d"/><high value="${xesc(m.days)}" unit="d"/></rateQuantity>` : ''}
          <consumable>
            <manufacturedProduct classCode="MANU">
              <manufacturedMaterial>
                <code code="${xesc(m.code || '')}" codeSystemName="EOF" displayName="${xesc(m.name || '')}"/>
                <name>${xesc(m.name || '')}</name>
              </manufacturedMaterial>
            </manufacturedProduct>
          </consumable>
        </substanceAdministration>
      </entry>`).join('');
  const exams = (p.examinations || []).map((e: any) => `
      <entry>
        <procedure classCode="PROC" moodCode="RQO">
          <id extension="${xesc(e.id || '')}" root="1.31"/>
          <code code="${xesc(e.code || '')}" codeSystemName="EDAPY" displayName="${xesc(e.name || '')}"/>
          <statusCode code="new"/>
          ${e.group ? `<text>${xesc(e.group)}</text>` : ''}
        </procedure>
      </entry>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ΠΡΟΕΠΙΣΚΟΠΗΣΗ (draft) — CRM Medi360 · ${isExams ? 'Παραπεμπτικό εξετάσεων' : 'Συνταγή φαρμάκων'} · env=${ENV_LABEL} · δεν έχει αποσταλεί στο ΣΗΣ -->
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <realmCode code="GR"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <id root="1.21" extension="0000000000000"/>
  <code code="${isExams ? '57833-6' : '57833-6'}" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="${isExams ? 'eReferral' : 'ePrescription'}"/>
  <title>${isExams ? 'Greek eReferral' : 'Greek ePrescription'}</title>
  <effectiveTime value="${now}"/>
  <languageCode code="el"/>
  <recordTarget contextControlCode="OP" typeCode="RCT">
    <patientRole>
      <id root="1.10.1" extension="${xesc(digits(patient?.amka))}"/>
      <patient>
        <name><given>${xesc(given)}</given><family>${xesc(family)}</family></name>
        <administrativeGenderCode code="${gender}" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="${dob}"/>
      </patient>
    </patientRole>
  </recordTarget>
  <author>
    <time value="${today}"/>
    <assignedAuthor>
      <id root="1.19" extension="${xesc(digits(doctor?.doctor_amka))}"/>
      ${doctor?.prescriber_code ? `<id root="1.18" extension="${xesc(doctor.prescriber_code)}"/>` : ''}
      <assignedPerson><name>${xesc(doctor?.full_name || '')}</name></assignedPerson>
    </assignedAuthor>
  </author>
  <componentOf>
    <encompassingEncounter>
      <id root="1.80" extension="PENDING-VISIT"/>
      <id root="1.80.1" extension="PENDING-UNIT"/>
      <code code="new"/>
      <effectiveTime><low value="${now}"/></effectiveTime>
    </encompassingEncounter>
  </componentOf>
  <component>
    <structuredBody>
      <component>
        <section>
          <title>${isExams ? 'Παραπεμπτικό' : 'Συνταγή'}</title>
          <entry>
            <act classCode="INFRM" moodCode="EVN">
              <statusCode code="new"/>
              ${isExams && p.referral_reason ? `<id root="1.31.2" extension="${xesc(p.referral_reason)}"/>` : ''}${diag}
            </act>
          </entry>${isExams ? exams : meds}
        </section>
      </component>
      ${p.notes ? `<component><section><title>Σχόλια</title><text>${xesc(p.notes)}</text></section></component>` : ''}
    </structuredBody>
  </component>
</ClinicalDocument>`;
}

// ── Συγχρονισμός masterdata (εξετάσεις / ICD-10) ──
async function syncMasterdata(admin: any, dataset: string) {
  const isExams = dataset === 'examinations';
  const path = isExams ? '/api/v1/masterdata/examinations' : '/api/v1/masterdata/icd10s';
  const size = isExams ? 500 : 1000;
  const { data: logRow } = await admin.from('idika_sync_log').insert({ dataset }).select('id').single();
  let total = 0, page = 0, totalPages = 1;
  try {
    while (page < totalPages && page < 80) {
      const r = await idikaFetch(`${path}?page=${page}&size=${size}`);
      if (r.status !== 200) throw new Error(`HTTP ${r.status} στη σελίδα ${page}: ${r.text.slice(0, 200)}`);
      totalPages = parseInt(xmlTag(r.text, 'totalPages') || '1', 10) || 1;
      const items = xmlItems(r.text);
      const rows = items.map(it => {
        if (isExams) {
          const grp = (it.match(/<examinationGroup>([\s\S]*?)<\/examinationGroup>/) || [])[1] || '';
          const sub = (it.match(/<examinationSubgroup>([\s\S]*?)<\/examinationSubgroup>/) || [])[1] || '';
          return {
            id: parseInt(tagIn(it, 'id'), 10), code: tagIn(it, 'codeEdapi') || null, description: tagIn(it, 'description') || '—',
            keywords: tagIn(it, 'keyWords') || null, group_id: grp ? parseInt(tagIn(grp, 'id'), 10) || null : null,
            group_name: grp ? tagIn(grp, 'name') || null : null, subgroup_name: sub ? tagIn(sub, 'name') || null : null,
            active: tagIn(it, 'active') !== 'false', is_high_cost: tagIn(it, 'isHighCost') === 'true',
            raw: null, synced_at: new Date().toISOString(),
          };
        }
        return {
          id: parseInt(tagIn(it, 'id'), 10), code: tagIn(it, 'code'), title: tagIn(it, 'title') || tagIn(it, 'description') || '—',
          description: tagIn(it, 'description') || null, active: !tagIn(it, 'endDate'),
          only_by_protocol: tagIn(it, 'onlyByProtocol') === 'true', raw: null, synced_at: new Date().toISOString(),
        };
      }).filter(r => Number.isFinite(r.id));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await admin.from(isExams ? 'idika_examinations' : 'idika_icd10s').upsert(rows.slice(i, i + 500), { onConflict: 'id' });
        if (error) throw new Error(error.message);
      }
      total += rows.length; page++;
    }
    await admin.from('idika_sync_log').update({ finished_at: new Date().toISOString(), rows: total, ok: true }).eq('id', logRow?.id);
    return { ok: true, dataset, rows: total, pages: page };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from('idika_sync_log').update({ finished_at: new Date().toISOString(), rows: total, ok: false, error: msg }).eq('id', logRow?.id);
    return { ok: false, dataset, rows: total, pages: page, error: msg };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'Invalid JSON' }, 400);
    const action = String(body.action || 'status');
    callerIp = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();

    // ── Ταυτοποίηση ──
    let cid = '', role = 'super_admin', canDiag = true, userId: string | null = null;
    const cronSecret = Deno.env.get('BIRTHDAY_CRON_SECRET');
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    if (cronSecret && req.headers.get('x-cron-secret') === cronSecret) {
      cid = String(body.clinic_id || '');
      if (!cid) return json({ error: 'clinic_id required' }, 400);
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);
      const userSb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
      const { data: { user }, error: userErr } = await userSb.auth.getUser();
      if (userErr || !user) return json({ error: 'Not authenticated' }, 401);
      const { data: profile } = await admin.from('profiles').select('role,clinic_id,can_view_diagnosis').eq('id', user.id).single();
      if (!profile) return json({ error: 'Profile not found' }, 403);
      role = profile.role; userId = user.id;
      canDiag = role === 'super_admin' || role === 'clinic_admin' || (role === 'therapist' && !!profile.can_view_diagnosis);
      if (!canDiag) return json({ error: 'Δεν έχεις δικαίωμα πρόσβασης στη συνταγογράφηση.' }, 403);
      cid = (role === 'super_admin' && body.clinic_id) ? String(body.clinic_id) : profile.clinic_id;
      if (!cid) return json({ error: 'Δεν βρέθηκε κλινική' }, 400);
    }

    await loadSecrets(admin);

    // ── status ──
    if (action === 'status') {
      const [{ count: nExams }, { count: nIcd }, { data: lastSync }] = await Promise.all([
        admin.from('idika_examinations').select('id', { count: 'exact', head: true }),
        admin.from('idika_icd10s').select('id', { count: 'exact', head: true }),
        admin.from('idika_sync_log').select('dataset,finished_at,rows,ok,error').order('started_at', { ascending: false }).limit(4),
      ]);
      return json({ ok: true, configured: configured(), env: ENV_LABEL, base: BASE, key_header: KEY_HEADER, user: secretCache.IDIKA_USER ? 'set' : 'missing',
        masterdata: { examinations: nExams || 0, icd10s: nIcd || 0, last_sync: lastSync || [] } });
    }

    // ── test ──
    if (action === 'test') {
      if (!['super_admin', 'clinic_admin'].includes(role)) return json({ error: 'Μόνο διαχειριστές.' }, 403);
      if (!configured()) return json({ ok: false, configured: false, error: 'Δεν έχουν οριστεί τα διαπιστευτήρια ΗΔΙΚΑ (IDIKA_API_KEY / IDIKA_USER / IDIKA_PASS).' });
      const r = await idikaFetch('/api/v1/me');
      const snippet = r.text.replace(/\s+/g, ' ').slice(0, 600);
      let units: any = null;
      if (r.status === 200) {
        const u = await idikaFetch('/api/v1/me/units');
        units = u.status === 200 ? parseInt(xmlTag(u.text, 'count') || '0', 10) : null;
      }
      const doctor = r.status === 200 ? {
        lastname: xmlTag(r.text, 'lastname'), firstname: xmlTag(r.text, 'firstname'), amka: xmlTag(r.text, 'amka'),
        specialty: (r.text.match(/<doctorSpecialty>[\s\S]*?<name>([^<]*)<\/name>/) || [])[1] || '', units,
      } : null;
      return json({ ok: r.status === 200, configured: true, env: ENV_LABEL, http_status: r.status, doctor, snippet });
    }

    // ── sync_masterdata ──
    if (action === 'sync_masterdata') {
      if (!['super_admin', 'clinic_admin'].includes(role)) return json({ error: 'Μόνο διαχειριστές.' }, 403);
      if (!configured()) return json({ ok: false, error: 'Δεν έχουν οριστεί τα διαπιστευτήρια ΗΔΙΚΑ.' });
      const dataset = String(body.dataset || '');
      if (!['examinations', 'icd10s'].includes(dataset)) return json({ error: 'dataset: examinations | icd10s' }, 400);
      return json(await syncMasterdata(admin, dataset));
    }

    // ── send: έλεγχοι + προεπισκόπηση (+ επιβεβαίωση σύνδεσης) ──
    if (action === 'send') {
      const pid = String(body.prescription_id || '');
      if (!pid) return json({ error: 'prescription_id required' }, 400);
      const { data: p } = await admin.from('prescriptions').select('*').eq('id', pid).eq('clinic_id', cid).maybeSingle();
      if (!p) return json({ error: 'Η συνταγή δεν βρέθηκε' }, 404);
      if (p.status === 'cancelled' || p.status === 'issued') return json({ error: `Είναι ήδη ${p.status === 'issued' ? 'εκδομέν' : 'ακυρωμέν'}${p.kind === 'exams' ? 'ο' : 'η'}.` }, 400);
      const isExams = p.kind === 'exams';
      const [{ data: patient }, { data: doctor }] = await Promise.all([
        admin.from('patients').select('id,full_name,amka,dob,gender,gdpr_signed').eq('id', p.patient_id).maybeSingle(),
        p.doctor_id ? admin.from('profiles').select('id,full_name,role,doctor_amka,prescriber_code').eq('id', p.doctor_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);

      const checks: Check[] = [];
      const pAmka = digits(patient?.amka);
      checks.push({ key: 'patient_amka', label: 'ΑΜΚΑ ασθενή (11 ψηφία)', ok: pAmka.length === 11, detail: pAmka ? pAmka.replace(/^(\d{6})\d{5}$/, '$1•••••') : 'λείπει' });
      checks.push({ key: 'patient_dob', label: 'Ημ. γέννησης ασθενή', ok: !!patient?.dob, detail: patient?.dob || 'λείπει' });
      checks.push({ key: 'patient_gender', label: 'Φύλο ασθενή', ok: patient?.gender === 'male' || patient?.gender === 'female', detail: patient?.gender || 'λείπει' });
      checks.push({ key: 'gdpr', label: 'Υπογεγραμμένο GDPR', ok: !!patient?.gdpr_signed });
      checks.push({ key: 'doctor', label: 'Ιατρός συνταγογράφος', ok: !!doctor, detail: doctor?.full_name || 'δεν έχει οριστεί' });
      const dAmka = digits(doctor?.doctor_amka);
      checks.push({ key: 'doctor_amka', label: 'ΑΜΚΑ ιατρού (Προσωπικό → Στοιχεία Συνταγογράφου)', ok: dAmka.length === 11, detail: dAmka ? 'ok' : 'λείπει' });
      const diags = Array.isArray(p.diagnoses) ? p.diagnoses : [];
      checks.push({ key: 'diagnoses', label: 'Τουλάχιστον 1 διάγνωση με ICD-10 (έως 10)', ok: diags.length >= 1 && diags.length <= 10 && diags.every((d: any) => d && d.icd10), detail: `${diags.length} διαγνώσεις, ${diags.filter((d: any) => d && d.icd10).length} με ICD-10` });
      if (isExams) {
        const exams = Array.isArray(p.examinations) ? p.examinations : [];
        checks.push({ key: 'examinations', label: 'Τουλάχιστον 1 εξέταση από τον κατάλογο ΗΔΙΚΑ', ok: exams.length >= 1 && exams.every((e: any) => e && e.id), detail: `${exams.length} εξετάσεις` });
        checks.push({ key: 'reason', label: 'Λόγος παραπομπής', ok: !!p.referral_reason, detail: p.referral_reason || 'λείπει' });
      } else {
        const meds = Array.isArray(p.medicines) ? p.medicines : [];
        checks.push({ key: 'medicines', label: 'Τουλάχιστον 1 σκεύασμα με κωδικό ΕΟΦ/barcode', ok: meds.length >= 1 && meds.every((m: any) => m && m.code), detail: `${meds.length} σκευάσματα, ${meds.filter((m: any) => m && m.code).length} με κωδικό` });
        checks.push({ key: 'quantities', label: 'Ποσότητα ≥ 1 σε κάθε σκεύασμα', ok: meds.every((m: any) => Number(m.quantity || 0) >= 1) });
      }
      const allOk = checks.every(c => c.ok);

      const xml = buildPreviewXml(p, patient, doctor);
      let connection: any = null;
      if (configured()) {
        try {
          const r = await idikaFetch('/api/v1/me');
          let units: number | null = null;
          if (r.status === 200) { const u = await idikaFetch('/api/v1/me/units'); units = u.status === 200 ? parseInt(xmlTag(u.text, 'count') || '0', 10) : null; }
          connection = { ok: r.status === 200, http_status: r.status, doctor: r.status === 200 ? `${xmlTag(r.text, 'lastname')} ${xmlTag(r.text, 'firstname')}`.trim() : null, units };
        } catch (e) { connection = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      }

      await admin.from('prescriptions').update({
        preview_xml: xml,
        patient_amka: pAmka || null, doctor_amka: dAmka || null, prescriber_code: doctor?.prescriber_code || null,
        idika_env: ENV_LABEL,
        idika_response: { mode: 'preview', at: new Date().toISOString(), checks, connection, by: userId },
        error_message: allOk ? null : 'Ελλιπή στοιχεία: ' + checks.filter(c => !c.ok).map(c => c.label).join(', '),
      }).eq('id', pid);

      const noUnit = connection && connection.ok && connection.units === 0;
      return json({
        ok: true, preview: true, configured: configured(), env: ENV_LABEL, kind: p.kind, checks, all_ok: allOk, connection, xml,
        note: !configured()
          ? 'Demo/προεπισκόπηση: δεν έχουν οριστεί διαπιστευτήρια ΗΔΙΚΑ — τίποτα δεν στάλθηκε.'
          : noUnit
            ? 'Σύνδεση ΟΚ, αλλά ο χρήστης ΗΣ δεν έχει μονάδα συνταγογράφησης στο UAT — η ΗΔΙΚΑ πρέπει να την αντιστοιχίσει πριν την πρώτη πραγματική καταχώρηση.'
            : 'Σύνδεση ΟΚ. Η πραγματική καταχώρηση στο ΣΗΣ ενεργοποιείται στο επόμενο βήμα (επίσκεψη + CDA).',
      });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
