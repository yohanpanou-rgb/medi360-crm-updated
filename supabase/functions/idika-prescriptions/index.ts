// Supabase Edge Function — Ηλεκτρονική Συνταγογράφηση (ΗΔΙΚΑ, API Ιατρών) για το CRM.
//
// Οντότητα «Συνταγή» = πίνακας public.prescriptions (γεννιέται από Ιατρική Εξέταση
// ή χειροκίνητα, κρατά διαγνώσεις ICD-10 + σκευάσματα ΕΟΦ και τον κύκλο ζωής
// draft → sent → issued / error / cancelled). Αυτή η function είναι το ΜΟΝΟ σημείο
// που μιλά με το ΣΗΣ — το frontend δεν αγγίζει ποτέ κλειδιά/κωδικούς.
//
// Actions (POST, JSON):
//   { action:'status' }                      → αν είναι ρυθμισμένη η σύνδεση (secrets), περιβάλλον
//   { action:'test' }                        → GET /api/v1/me με τα credentials (ενεργή σύνδεση 24ώρου)
//   { action:'send', prescription_id }       → έλεγχοι πληρότητας + προεπισκόπηση XML (CDA draft)
//                                              και, αν υπάρχει σύνδεση, επιβεβαίωση /api/v1/me.
//                                              Η ΠΡΑΓΜΑΤΙΚΗ καταχώρηση (POST /api/v1/me/visits +
//                                              /api/v1/me/prescriptions) ενεργοποιείται μόλις
//                                              ολοκληρωθεί η προδιαγραφή CDA από το Wiki του API.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   IDIKA_API_KEY   APPLICATION API KEY (κοινό για test/preprod/prod)
//   IDIKA_USER      δοκιμαστικός χρήστης ΗΣ (medi360docapi)
//   IDIKA_PASS      κωδικός του
//   IDIKA_BASE      (προαιρετικό) default https://testeps.e-prescription.gr/docapiv2
//   IDIKA_KEY_HEADER(προαιρετικό) όνομα header για το api key, default 'api-key'
//
// Auth κλήσης: JWT χρήστη (super_admin/clinic_admin, ή therapist με can_view_diagnosis)
// ή x-cron-secret = BIRTHDAY_CRON_SECRET (+ body.clinic_id) για δοκιμές.
// Deploy: supabase functions deploy idika-prescriptions --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const BASE = (Deno.env.get('IDIKA_BASE') || 'https://testeps.e-prescription.gr/docapiv2').replace(/\/$/, '');
// Επιβεβαιωμένο εμπειρικά 26/09/2026 στο UAT: το application key διαβάζεται από το header
// `api-key` (τα 'apikey', 'x-api-key' κ.λπ. επιστρέφουν 604 «You must provide a valid api key»).
const KEY_HEADER = Deno.env.get('IDIKA_KEY_HEADER') || 'api-key';
const ENV_LABEL = BASE.includes('testeps') || BASE.includes('test.') ? 'uat' : 'production';

function configured() {
  return !!(Deno.env.get('IDIKA_API_KEY') && Deno.env.get('IDIKA_USER') && Deno.env.get('IDIKA_PASS'));
}

// Κλήση προς το API Ιατρών: Basic auth (χρήστης ΗΣ) + application key στο header.
async function idikaFetch(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    Accept: 'application/xml, application/json;q=0.9, */*;q=0.5',
    Authorization: 'Basic ' + btoa(`${Deno.env.get('IDIKA_USER')}:${Deno.env.get('IDIKA_PASS')}`),
    [KEY_HEADER]: Deno.env.get('IDIKA_API_KEY') || '',
    ...(init.headers as Record<string, string> || {}),
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(BASE + path, { ...init, headers, signal: ctrl.signal });
    const text = await r.text();
    return { status: r.status, text };
  } finally { clearTimeout(t); }
}

const xmlTag = (xml: string, tag: string) => { const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)); return m ? m[1] : ''; };
const xesc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

type Check = { key: string; label: string; ok: boolean; detail?: string };

// Προεπισκόπηση συνταγής σε δομή CDA (HL7 v3). ΠΡΟΚΑΤΑΡΚΤΙΚΗ: τα id roots που
// γνωρίζουμε από τα έγγραφα της ΗΔΙΚΑ (1.10.1 = ΑΜΚΑ ασθενή) χρησιμοποιούνται· τα
// υπόλοιπα στοιχεία (templateIds, codeSystems ΕΟΦ/ICD-10, δοσολογία) θα ευθυγραμμιστούν
// με την επίσημη προδιαγραφή του Wiki πριν την πρώτη πραγματική καταχώρηση.
function buildPreviewXml(p: any, patient: any, doctor: any) {
  const dob = patient?.dob ? String(patient.dob).replace(/-/g, '') : '';
  const gender = patient?.gender === 'male' ? 'M' : patient?.gender === 'female' ? 'F' : 'UN';
  const [given, ...rest] = String(patient?.full_name || '').trim().split(/\s+/);
  const family = rest.join(' ');
  const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDhhmmss
  const diag = (p.diagnoses || []).map((d: any) => `
        <entry>
          <observation classCode="OBS" moodCode="EVN">
            <code code="${xesc(d.icd10 || '')}" codeSystemName="ICD-10" displayName="${xesc(d.name || '')}"/>
          </observation>
        </entry>`).join('');
  const meds = (p.medicines || []).map((m: any) => `
        <entry>
          <substanceAdministration classCode="SBADM" moodCode="INT">
            <text>${xesc(m.dosage || '')}</text>
            ${m.days ? `<effectiveTime xsi:type="IVL_TS"><width value="${xesc(m.days)}" unit="d"/></effectiveTime>` : ''}
            <doseQuantity value="${xesc(m.quantity || 1)}"/>
            <consumable>
              <manufacturedProduct>
                <manufacturedMaterial>
                  <code code="${xesc(m.code || '')}" codeSystemName="EOF" displayName="${xesc(m.name || '')}"/>
                  <name>${xesc(m.name || '')}</name>
                </manufacturedMaterial>
              </manufacturedProduct>
            </consumable>
          </substanceAdministration>
        </entry>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ΠΡΟΕΠΙΣΚΟΠΗΣΗ (draft) — CRM Medi360 · env=${ENV_LABEL} · δεν έχει αποσταλεί στο ΣΗΣ -->
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <id root="medi360.prescription" extension="${xesc(p.id)}"/>
  <code displayName="Συνταγή Φαρμάκων"/>
  <effectiveTime value="${now}"/>
  <recordTarget>
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
    <time value="${now}"/>
    <assignedAuthor>
      <id root="1.10.1" extension="${xesc(digits(doctor?.doctor_amka))}"/>
      ${doctor?.prescriber_code ? `<id root="medi360.prescriberCode" extension="${xesc(doctor.prescriber_code)}"/>` : ''}
      <assignedPerson><name>${xesc(doctor?.full_name || '')}</name></assignedPerson>
    </assignedAuthor>
  </author>
  <component>
    <structuredBody>
      <component><section><title>Διαγνώσεις</title>${diag}
      </section></component>
      <component><section><title>Θεραπείες</title>${meds}
      </section></component>
      ${p.notes ? `<component><section><title>Σχόλια</title><text>${xesc(p.notes)}</text></section></component>` : ''}
    </structuredBody>
  </component>
</ClinicalDocument>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'Invalid JSON' }, 400);
    const action = String(body.action || 'status');

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

    // ── status ──
    if (action === 'status') {
      return json({ ok: true, configured: configured(), env: ENV_LABEL, base: BASE, key_header: KEY_HEADER, user: Deno.env.get('IDIKA_USER') ? 'set' : 'missing' });
    }

    // ── test: /api/v1/me (login + «ενεργή σύνδεση» 24ώρου) ──
    if (action === 'test') {
      if (!['super_admin', 'clinic_admin'].includes(role)) return json({ error: 'Μόνο διαχειριστές.' }, 403);
      if (!configured()) return json({ ok: false, configured: false, error: 'Δεν έχουν οριστεί τα secrets IDIKA_API_KEY / IDIKA_USER / IDIKA_PASS στο Supabase.' });
      const r = await idikaFetch('/api/v1/me');
      const snippet = r.text.replace(/\s+/g, ' ').slice(0, 600);
      const doctor = r.status === 200 ? {
        lastname: xmlTag(r.text, 'lastname'), firstname: xmlTag(r.text, 'firstname'), amka: xmlTag(r.text, 'amka'),
        specialty: (r.text.match(/<doctorSpecialty>[\s\S]*?<name>([^<]*)<\/name>/) || [])[1] || '',
      } : null;
      return json({ ok: r.status === 200, configured: true, env: ENV_LABEL, http_status: r.status, doctor, snippet });
    }

    // ── send: έλεγχοι + προεπισκόπηση (+ επιβεβαίωση σύνδεσης) ──
    if (action === 'send') {
      const pid = String(body.prescription_id || '');
      if (!pid) return json({ error: 'prescription_id required' }, 400);
      const { data: p } = await admin.from('prescriptions').select('*').eq('id', pid).eq('clinic_id', cid).maybeSingle();
      if (!p) return json({ error: 'Η συνταγή δεν βρέθηκε' }, 404);
      if (p.status === 'cancelled' || p.status === 'issued') return json({ error: `Η συνταγή είναι ήδη ${p.status === 'issued' ? 'εκδομένη' : 'ακυρωμένη'}.` }, 400);
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
      const meds = Array.isArray(p.medicines) ? p.medicines : [];
      checks.push({ key: 'diagnoses', label: 'Τουλάχιστον 1 διάγνωση με ICD-10 (έως 10)', ok: diags.length >= 1 && diags.length <= 10 && diags.every((d: any) => d && d.icd10), detail: `${diags.length} διαγνώσεις, ${diags.filter((d: any) => d && d.icd10).length} με ICD-10` });
      checks.push({ key: 'medicines', label: 'Τουλάχιστον 1 σκεύασμα με κωδικό ΕΟΦ/barcode', ok: meds.length >= 1 && meds.every((m: any) => m && m.code), detail: `${meds.length} σκευάσματα, ${meds.filter((m: any) => m && m.code).length} με κωδικό` });
      checks.push({ key: 'quantities', label: 'Ποσότητα ≥ 1 σε κάθε σκεύασμα', ok: meds.every((m: any) => Number(m.quantity || 0) >= 1) });
      const allOk = checks.every(c => c.ok);

      const xml = buildPreviewXml(p, patient, doctor);
      let connection: any = null;
      if (configured()) {
        try {
          const r = await idikaFetch('/api/v1/me');
          connection = { ok: r.status === 200, http_status: r.status, doctor: r.status === 200 ? `${xmlTag(r.text, 'lastname')} ${xmlTag(r.text, 'firstname')}`.trim() : null };
        } catch (e) { connection = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      }

      // Δεν αλλάζει status: παραμένει draft μέχρι να υπάρξει πραγματική καταχώρηση.
      await admin.from('prescriptions').update({
        preview_xml: xml,
        patient_amka: pAmka || null, doctor_amka: dAmka || null, prescriber_code: doctor?.prescriber_code || null,
        idika_env: ENV_LABEL,
        idika_response: { mode: 'preview', at: new Date().toISOString(), checks, connection, by: userId },
        error_message: allOk ? null : 'Ελλιπή στοιχεία: ' + checks.filter(c => !c.ok).map(c => c.label).join(', '),
      }).eq('id', pid);

      return json({
        ok: true, preview: true, configured: configured(), env: ENV_LABEL, checks, all_ok: allOk, connection, xml,
        note: configured()
          ? 'Η σύνδεση με το ΣΗΣ λειτουργεί. Η πραγματική καταχώρηση συνταγής ενεργοποιείται μόλις ολοκληρωθεί η προδιαγραφή CDA (Wiki API Ιατρών).'
          : 'Demo/προεπισκόπηση: δεν έχουν οριστεί κωδικοί ΗΔΙΚΑ στο Supabase — τίποτα δεν στάλθηκε.',
      });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
