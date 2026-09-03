// Supabase Edge Function — 📋 Καθημερινή Αναφορά Ελέγχου Ραντεβού & Πελατών.
//
// Κάθε πρωί (ώρα ρυθμιζόμενη ανά κλινική στο clinics.settings.daily_audit,
// ώρα Ελλάδας) στέλνει email με συνημμένο PDF, ελέγχοντας τα σημερινά
// ραντεβού για: GDPR συναίνεση, consultation (έχει γίνει ποτέ), συναίνεση
// υπηρεσίας (laser/καθαρισμού/peeling/οξυγόνου), πληρότητα στοιχείων
// πελάτη (email/τηλέφωνο/πόλη/γέννηση), εκκρεμές «επόμενο βήμα» consultation,
// και σήμανση νέου πελάτη.
//
// Το «επόμενο βήμα» χρησιμοποιεί ΑΚΡΙΒΩΣ την ίδια λογική ταιριάσματος με
// την καρτέλα ασθενή (tab Consultation) στο index.html — parseConsultInClinicSteps
// + findServiceMatch — ώστε το «X βήματα εκκρεμούν» εδώ να συμφωνεί πάντα με
// το «⏳ X/Y έγιναν» badge που βλέπει ο χρήστης στο CRM.
//
// Ώρα αποστολής: pg_cron καλεί αυτό το function κάθε 15 λεπτά (βλ.
// supabase/create_daily_audit_report.sql). Το ίδιο το function υπολογίζει
// την ΠΡΑΓΜΑΤΙΚΗ τοπική ώρα Ελλάδας σε κάθε κλήση (ανεξάρτητα από
// θερινή/χειμερινή ώρα — δεν χρειάζεται pg_cron σε ώρα Ελλάδας) και τη
// συγκρίνει με το ρυθμισμένο daily_audit.send_time ανά κλινική· στέλνει μόνο
// όταν ταιριάζουν (στρογγυλοποιημένα σε 15λεπτο). Το {force:true} στο body
// παρακάμπτει τον έλεγχο ώρας (χειροκίνητη δοκιμή/αποστολή, προαιρετικά με
// συγκεκριμένο clinic_id).
//
// PDF: παράγεται με pdf-lib (καθαρό JS, τρέχει μέσα στο Deno edge runtime —
// όχι headless browser, μη διαθέσιμο εκεί) με ενσωματωμένη γραμματοσειρά
// Noto Sans (Regular, στατικό instance — όχι variable font, για συμβατότητα)
// για υποστήριξη ελληνικών. ΣΗΜΑΝΤΙΚΟ: embedFont() με {subset:true} — το
// fontkit subsetting που χρησιμοποιεί το pdf-lib — χαλάει το glyph table
// αυτής της γραμματοσειράς και βγάζει σπασμένο/λειψό κείμενο (επιβεβαιωμένο
// τοπικά, σε πραγματικό PDF). Γι' αυτό εδώ γίνεται embed ολόκληρη η
// γραμματοσειρά ({subset:false}) — μερικές εκατοντάδες KB παραπάνω στο PDF,
// αμελητέο για συνημμένο email. Η γραμματοσειρά «κατεβαίνει» τη στιγμή
// της εκτέλεσης (μία φορά ανά cold start, μέσω module-level cache) από το
// ίδιο το repo του project στο GitHub
// (supabase/functions/daily-audit-report/fonts/NotoSans-Regular.ttf) —
// καθαρό font asset, όχι δεδομένα πελατών· κανένα δεδομένο πελάτη/
// ραντεβού δεν στέλνεται πουθενά εκτός Google (Gmail) και του ίδιου του
// Supabase project.
//
// Deploy with:
//   supabase functions deploy daily-audit-report --no-verify-jwt
// Secrets (υπάρχουν ήδη στο project, τίποτα νέο):
//   BIRTHDAY_CRON_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BL_REFRESH_TOKEN

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
// @ts-ignore — δεν υπάρχουν επίσημα types για fontkit εδώ
import fontkit from 'https://esm.sh/@pdf-lib/fontkit@1.1.1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function esc(x: unknown) {
  return (x == null ? '' : String(x)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getGmailAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID')!,
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
      refresh_token: Deno.env.get('BL_REFRESH_TOKEN')!,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  return data.access_token;
}

// UTF-8 / binary safe base64
function b64Bytes(bytes: Uint8Array): string {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function b64utf8(s: string): string {
  return b64Bytes(new TextEncoder().encode(s));
}

// ── ΛΟΓΙΚΗ ΤΑΥΤΟΣΗΜΗ ΜΕ index.html (ΜΗΝ ΑΠΟΚΛΙΝΕΙ) ──────────────────────

function normalizeGreek(s: string | null | undefined): string {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\wα-ωΑ-Ω0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

type ConsentGroup = 'laser' | 'cleansing' | 'peelings' | 'oxygen' | null;
function classifyConsentGroup(serviceName: string | null | undefined): ConsentGroup {
  let s = (serviceName || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/nano\s?-?peel\w*/g, ' ');
  if (/alexandrite|laser/.test(s)) return 'laser';
  if (/καθαρισμ|δερμοαποξ|pore ?over|eco ?peel/.test(s)) return 'cleansing';
  if (/peeling|peel|prx|dermapen|μικροβελον|microneedl|tca/.test(s)) return 'peelings';
  if (/οξυγον|ενυδατ|dermalux|λαμψ|λευκανσ|αντιγηρανσ|glow/.test(s)) return 'oxygen';
  return null;
}
const CONSENT_GROUP_LABEL: Record<string, string> = { laser: 'Laser', cleansing: 'Καθαρισμού', peelings: 'Peeling', oxygen: 'Οξυγόνου' };
const CONSENT_GROUP_DB: Record<string, string> = { cleansing: 'cleansing_poreover', peelings: 'peelings_microneedling', oxygen: 'oxygen_facetreatments' };

function classifyConsultationType(text: string | null | undefined): string {
  const t = text || '';
  if (t.includes('Skincare Plan') || /IN-CLINIC|SKIN PROFILE|HOMECARE/.test(t)) return 'consultation';
  if (/laser/i.test(t)) return 'laser';
  return 'other';
}

// Εξάγει τα βήματα (μία γραμμή = ένα βήμα) του IN-CLINIC μέρους ενός
// consultation consent_text — ίδια κοκκομετρία/regex με το progress badge
// της καρτέλας ασθενή (tab Consultation) στο index.html.
function parseConsultInClinicSteps(text: string | null | undefined): string[] {
  const m = (text || '').match(/IN-CLINIC\s*:?\s*\n?([\s\S]+?)(?:\n\s*(?:BODY|HOMECARE|EXPECTED|Σημειώσεις)|$)/i);
  if (!m) return [];
  return m[1].split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const nm = l.match(/^\d\)\s*(.*)$/);
    if (nm) { const c = nm[1].trim(); return c.includes(':') ? c.split(':').slice(1).join(':').trim() : c; }
    return l.replace(/^[•\-]\s*/, '');
  }).filter((t) => t.length >= 4);
}

interface ApptRow {
  id: string;
  patient_id: string;
  service_name: string | null;
  start_time: string;
  status: string;
}

// Ίδιο ταίριασμα με το findServiceMatch(index.html): ψάχνει το πιο κοντινό
// μελλοντικό (ή ήδη περασμένο) μη-ακυρωμένο ραντεβού του πελάτη ΜΕΤΑ την
// ημερομηνία του consultation, που να αντιστοιχεί στο κείμενο του βήματος.
function findServiceMatch(appointments: ApptRow[], afterDateStr: string, treatmentText: string): ApptRow | null {
  const afterDate = new Date(afterDateStr);
  const normTreatment = normalizeGreek(treatmentText);
  const treatWords = normTreatment.split(' ').filter((w) => w.length >= 4);
  if (!treatWords.length) return null;
  const candidates = (appointments || []).filter((a) => a.start_time && a.status !== 'cancelled' && new Date(a.start_time) > afterDate);
  candidates.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  for (const a of candidates) {
    const normService = normalizeGreek(a.service_name || '');
    if (!normService) continue;
    if (normService.includes(normTreatment) || normTreatment.includes(normService)) return a;
    const overlap = treatWords.filter((w) => normService.includes(w));
    if (overlap.length >= Math.min(2, treatWords.length)) return a;
  }
  return null;
}

// ── ΤΥΠΟΙ ────────────────────────────────────────────────────────────────

interface Patient {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  dob: string | null;
  gdpr_signed: boolean | null;
}
interface TodayAppt extends ApptRow {
  patients: Patient | null;
}
interface ConsultRow { patient_id: string; consent_text: string | null; signed_at: string | null; }

interface DailyAuditSettings {
  enabled?: boolean;
  recipients?: string[];
  send_time?: string;
  sections?: Record<string, boolean>;
}

interface PatientCheck {
  time: string;
  name: string;
  service: string;
  isNew: boolean;
  gdprOk: boolean | null; // null = ενότητα απενεργοποιημένη
  consultationDone: boolean | null;
  consultDate: string;
  consentGroup: ConsentGroup;
  consentOk: boolean | null; // null = δεν απαιτείται/ενότητα off
  nextStepPending: boolean | null; // null = N/A
  missingFields: string[]; // κενό = όλα εντάξει
  priority: 'red' | 'yellow' | 'green';
  actions: string[];
}

function sectionOn(sections: Record<string, boolean> | undefined, key: string): boolean {
  return !(sections && sections[key] === false);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const secret = Deno.env.get('BIRTHDAY_CRON_SECRET');
  const isCron = !!secret && req.headers.get('x-cron-secret') === secret;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Εκτός από cron, επιτρέπεται και χειροκίνητη δοκιμαστική αποστολή από τις
  // Ρυθμίσεις του CRM (κουμπί «Δοκιμαστική αποστολή τώρα») — απαιτεί έγκυρο
  // χρήστη με δικαίωμα διαχείρισης ρυθμίσεων της κλινικής.
  if (!isCron) {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401);
    const { data: profile, error: profileErr } = await supabase
      .from('profiles').select('role').eq('id', user.id).single();
    if (profileErr || !profile) return json({ error: 'Profile not found' }, 403);
    if (!['super_admin', 'clinic_admin'].includes(profile.role)) {
      return json({ error: 'Δεν έχεις δικαίωμα δοκιμαστικής αποστολής' }, 403);
    }
  }

  let body: { force?: boolean; clinic_id?: string } = {};
  try { body = await req.json(); } catch { /* κενό body από cron */ }

  try {

    let clinicsQuery = supabase.from('clinics').select('id, name, settings');
    if (body.clinic_id) clinicsQuery = clinicsQuery.eq('id', body.clinic_id);
    const { data: clinics, error: clinicsErr } = await clinicsQuery;
    if (clinicsErr) return json({ error: 'Clinics: ' + clinicsErr.message }, 500);

    const nowAthensHM = new Date().toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Athens' });
    const round15 = (hm: string) => {
      const [h, m] = hm.split(':').map(Number);
      return String(h).padStart(2, '0') + ':' + String(Math.floor(m / 15) * 15).padStart(2, '0');
    };
    const nowRounded = round15(nowAthensHM);

    const results: Record<string, unknown>[] = [];

    for (const clinic of (clinics || []) as { id: string; name: string; settings?: Record<string, unknown> }[]) {
      const audit: DailyAuditSettings = (clinic.settings && (clinic.settings.daily_audit as DailyAuditSettings)) || {};
      if (!audit.enabled) { results.push({ clinic: clinic.name, skipped: 'disabled' }); continue; }
      const recipients = (audit.recipients || []).filter(Boolean);
      if (!recipients.length) { results.push({ clinic: clinic.name, skipped: 'no recipients' }); continue; }

      if (!body.force) {
        const target = round15(audit.send_time || '08:00');
        if (target !== nowRounded) { results.push({ clinic: clinic.name, skipped: `ώρα ${nowRounded} ≠ ρυθμισμένη ${target}` }); continue; }
      }

      const sections = audit.sections || {};
      const cid = clinic.id;
      const brand = {
        name: (clinic.settings && (clinic.settings.brand_name as string)) || clinic.name || 'Beauty Line by Lina Panou',
        color: (clinic.settings && (clinic.settings.brand_color as string)) || '#C4618A',
      };

      // «Σήμερα» με βάση την ώρα Ελλάδας — τα start_time είναι UTC.
      const nowAthens = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Athens' }));
      const dstr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const todayStr = dstr(nowAthens);
      const tomorrow = new Date(nowAthens); tomorrow.setDate(tomorrow.getDate() + 1);

      const { data: todayApptsRaw, error: apptErr } = await supabase
        .from('appointments')
        .select('id, patient_id, service_name, start_time, status, patients(id, full_name, email, phone, city, dob, gdpr_signed)')
        .eq('clinic_id', cid)
        .gte('start_time', todayStr + 'T00:00:00')
        .lt('start_time', dstr(tomorrow) + 'T00:00:00')
        .neq('status', 'cancelled')
        .order('start_time');
      if (apptErr) { results.push({ clinic: clinic.name, error: apptErr.message }); continue; }
      const todayAppts = (todayApptsRaw || []) as unknown as TodayAppt[];
      if (!todayAppts.length) { results.push({ clinic: clinic.name, skipped: 'no appointments today' }); continue; }

      const patientIds = [...new Set(todayAppts.map((a) => a.patient_id).filter(Boolean))];

      // Consultations (gdpr_consents) — ΟΛΩΝ των εποχών, ανά πελάτη.
      const { data: consultRaw } = await supabase
        .from('gdpr_consents')
        .select('patient_id, consent_text, signed_at')
        .eq('clinic_id', cid)
        .in('patient_id', patientIds)
        .order('signed_at', { ascending: false });
      const consultByPatient: Record<string, ConsultRow[]> = {};
      ((consultRaw || []) as ConsultRow[]).forEach((c) => {
        if (classifyConsultationType(c.consent_text) !== 'consultation') return;
        (consultByPatient[c.patient_id] = consultByPatient[c.patient_id] || []).push(c);
      });

      // ΟΛΑ τα ραντεβού (όχι μόνο σήμερα) αυτών των πελατών — χρειάζεται για
      // το ταίριασμα επόμενου βήματος & για τον έλεγχο «νέος πελάτης».
      const { data: allApptsRaw } = await supabase
        .from('appointments')
        .select('id, patient_id, service_name, start_time, status')
        .eq('clinic_id', cid)
        .in('patient_id', patientIds);
      const allAppts = (allApptsRaw || []) as ApptRow[];
      const apptsByPatient: Record<string, ApptRow[]> = {};
      allAppts.forEach((a) => { (apptsByPatient[a.patient_id] = apptsByPatient[a.patient_id] || []).push(a); });

      const { data: laserRows } = await supabase.from('laser_consents').select('patient_id').eq('clinic_id', cid).in('patient_id', patientIds);
      const laserSet = new Set((laserRows || []).map((r: { patient_id: string }) => r.patient_id));
      const { data: svcRows } = await supabase.from('service_consents').select('patient_id, consent_group').eq('clinic_id', cid).in('patient_id', patientIds);
      const svcSets: Record<string, Set<string>> = { cleansing: new Set(), peelings: new Set(), oxygen: new Set() };
      ((svcRows || []) as { patient_id: string; consent_group: string }[]).forEach((r) => {
        for (const key of ['cleansing', 'peelings', 'oxygen']) {
          if (r.consent_group === CONSENT_GROUP_DB[key]) svcSets[key].add(r.patient_id);
        }
      });

      const checks: PatientCheck[] = [];
      for (const a of todayAppts) {
        const p = a.patients;
        if (!p) continue;
        const actions: string[] = [];

        const gdprOk = sectionOn(sections, 'gdpr') ? !!p.gdpr_signed : null;
        if (gdprOk === false) actions.push('Λήψη συναίνεσης GDPR πριν τη θεραπεία');

        const consultRecords = consultByPatient[p.id] || [];
        const consultationDone = sectionOn(sections, 'consultation') ? consultRecords.length > 0 : null;
        if (consultationDone === false) actions.push('Προγραμματισμός consultation');
        let consultDate = '';
        let nextStepPending: boolean | null = null;
        if (sectionOn(sections, 'next_step') && consultRecords.length) {
          const latest = consultRecords[0];
          consultDate = latest.signed_at ? new Date(latest.signed_at).toLocaleDateString('el-GR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
          const steps = parseConsultInClinicSteps(latest.consent_text);
          if (steps.length) {
            const patientAppts = apptsByPatient[p.id] || [];
            nextStepPending = steps.some((s) => !findServiceMatch(patientAppts, latest.signed_at || '', s));
            if (nextStepPending) actions.push('Κλείσιμο επόμενου ραντεβού / follow-up');
          }
        }

        const consentGroup = classifyConsentGroup(a.service_name);
        let consentOk: boolean | null = null;
        if (sectionOn(sections, 'service_consent') && consentGroup) {
          consentOk = consentGroup === 'laser' ? laserSet.has(p.id) : svcSets[consentGroup].has(p.id);
          if (!consentOk) actions.push(`Λήψη συναίνεσης ${CONSENT_GROUP_LABEL[consentGroup]} πριν τη θεραπεία`);
        }

        const missingFields: string[] = [];
        if (sectionOn(sections, 'data_completeness')) {
          if (!p.email) missingFields.push('Email');
          if (!p.phone) missingFields.push('Τηλέφωνο');
          if (!p.city) missingFields.push('Πόλη');
          if (!p.dob) missingFields.push('Ημ. Γέννησης');
          if (missingFields.length) actions.push('Συμπλήρωση: ' + missingFields.join(', '));
        }

        const isNew = sectionOn(sections, 'new_customer')
          ? !(apptsByPatient[p.id] || []).some((o) => o.id !== a.id && o.status === 'completed' && new Date(o.start_time) < new Date(a.start_time))
          : false;

        const highRisk = gdprOk === false || consultationDone === false || consentOk === false;
        const midRisk = nextStepPending === true || missingFields.length > 0;
        const priority: 'red' | 'yellow' | 'green' = highRisk ? 'red' : midRisk ? 'yellow' : 'green';

        checks.push({
          time: new Date(a.start_time).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Athens' }),
          name: p.full_name || '—',
          service: a.service_name || '',
          isNew,
          gdprOk,
          consultationDone,
          consultDate,
          consentGroup,
          consentOk,
          nextStepPending,
          missingFields,
          priority,
          actions,
        });
      }

      const dayLabel = nowAthens.toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const summary = {
        total: checks.length,
        gdprMissing: checks.filter((c) => c.gdprOk === false).length,
        consultMissing: checks.filter((c) => c.consultationDone === false).length,
        consentMissing: checks.filter((c) => c.consentOk === false).length,
        nextStepPending: checks.filter((c) => c.nextStepPending === true).length,
        incompleteData: checks.filter((c) => c.missingFields.length > 0).length,
      };

      const html = buildAuditHtml(dayLabel, brand, summary, checks);
      const pdfBytes = await buildAuditPdf(brand.name, dayLabel, summary, checks);
      const pdfFilename = `daily-audit-${todayStr}.pdf`;

      const subject = `📋 Beauty Line | Daily Audit — ${dayLabel} · ${checks.length} ραντεβού`;
      const token = await getGmailAccessToken();
      const raw = buildMimeMessage(brand.name, recipients, subject, html, pdfBytes, pdfFilename);
      const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      });
      const out = await gmailRes.json();
      if (out.error) {
        console.error('daily-audit-report: Gmail send failed', out.error);
        results.push({ clinic: clinic.name, error: 'Gmail: ' + JSON.stringify(out.error) });
        continue;
      }
      results.push({ clinic: clinic.name, sent: recipients, appointments: checks.length });
    }

    return json({ ok: true, results });
  } catch (e) {
    console.error('daily-audit-report failed:', e instanceof Error ? e.stack || e.message : e);
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});

// ── MIME ──────────────────────────────────────────────────────────────

function buildMimeMessage(fromName: string, to: string[], subject: string, html: string, pdfBytes: Uint8Array, pdfFilename: string): string {
  const boundary = 'audit_boundary_' + crypto.randomUUID().replace(/-/g, '');
  const headerLines = [
    `From: ${fromName.replace(/[\r\n]/g, '')} <yourbeautyline@gmail.com>`,
    `To: ${to.join(', ')}`,
    `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64utf8(html),
    ``,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${pdfFilename}"`,
    `Content-Disposition: attachment; filename="${pdfFilename}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64Bytes(pdfBytes),
    ``,
    `--${boundary}--`,
  ];
  const message = headerLines.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
  return b64utf8(message).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── HTML EMAIL (ίδιο layout με το εγκεκριμένο mockup — ανά πελάτη,
// χρονολογική σειρά) ─────────────────────────────────────────────────

function priorityBadge(p: 'red' | 'yellow' | 'green') {
  if (p === 'red') return { label: '🔴 ΥΨΗΛΗ', color: '#A32D2D' };
  if (p === 'yellow') return { label: '🟡 ΜΕΣΑΙΑ', color: '#854F0B' };
  return { label: '🟢 ΟΚ', color: '#0F6E56' };
}
function cardBorderColor(p: 'red' | 'yellow' | 'green') {
  return p === 'red' ? '#A32D2D' : p === 'yellow' ? '#D97706' : '#0F6E56';
}
function chip(text: string, ok: boolean | null) {
  const bg = ok === false ? '#FCEBEB' : '#E1F5EE';
  const c = ok === false ? '#A32D2D' : '#0F6E56';
  return `<span style="background-color:${bg};color:${c};-webkit-text-fill-color:${c};border-radius:8px;padding:2px 9px;margin-right:5px;display:inline-block;margin-bottom:4px">${esc(text)}</span>`;
}

function buildAuditHtml(dayLabel: string, brand: { name: string; color: string }, summary: { total: number; gdprMissing: number; consultMissing: number; consentMissing: number; nextStepPending: number; incompleteData: number }, checks: PatientCheck[]): string {
  const summaryCard = (n: number, label: string, bg: string, c: string) => `
    <td width="33%" style="padding:4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${bg};border-radius:12px;"><tr><td style="padding:14px 10px;text-align:center;">
        <div style="font-size:26px;font-weight:bold;color:${c};-webkit-text-fill-color:${c};">${n}</div>
        <div style="font-size:11px;color:#6B5A61;-webkit-text-fill-color:#6B5A61;margin-top:2px;">${esc(label)}</div>
      </td></tr></table>
    </td>`;

  const patientCard = (chk: PatientCheck) => {
    const bd = priorityBadge(chk.priority);
    const border = cardBorderColor(chk.priority);
    const bg = chk.priority === 'red' ? '#FEFAFA' : chk.priority === 'yellow' ? '#FEFCF8' : '#FAFEFC';
    const badges: string[] = [];
    if (chk.gdprOk !== null) badges.push(chip(chk.gdprOk ? '🟢 GDPR OK' : '🔴 GDPR: Λείπει', chk.gdprOk));
    if (chk.consultationDone !== null) badges.push(chip(chk.consultationDone ? `🟢 Consultation: Έγινε${chk.consultDate ? ' (' + chk.consultDate + ')' : ''}` : '🔴 Consultation: δεν έχει γίνει ποτέ', chk.consultationDone));
    if (chk.consentGroup) {
      if (chk.consentOk !== null) badges.push(chip(chk.consentOk ? `🟢 Συναίνεση ${CONSENT_GROUP_LABEL[chk.consentGroup]} OK` : `🔴 Συναίνεση ${CONSENT_GROUP_LABEL[chk.consentGroup]}: Λείπει`, chk.consentOk));
    } else {
      badges.push(chip('— Συναίνεση Υπηρεσίας: N/A', null));
    }
    if (chk.nextStepPending !== null) badges.push(chip(chk.nextStepPending ? '🟡 Επόμενο Βήμα: Δεν έχει κλειστεί' : '🟢 Επόμενο Βήμα: Κλεισμένο', !chk.nextStepPending));

    const dataBadges = ['Email', 'Τηλέφωνο', 'Πόλη', 'Ημ. Γέννησης'].map((f) => chip(f, !chk.missingFields.includes(f)));

    return `
    <tr><td style="padding:12px 32px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${bg};border:1px solid #F0E2E9;border-left:4px solid ${border};border-radius:12px;"><tr><td style="padding:14px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:14px;font-weight:bold;color:#333333;-webkit-text-fill-color:#333333;">${esc(chk.time)} — ${esc(chk.name)}${chk.isNew ? ' <span style="font-size:10px;font-weight:bold;color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;background-color:' + esc(brand.color) + ';border-radius:6px;padding:2px 7px;vertical-align:middle">NEW</span>' : ''}</td>
          <td style="text-align:right;font-size:11px;font-weight:bold;color:${bd.color};-webkit-text-fill-color:${bd.color};white-space:nowrap;">${bd.label}</td>
        </tr></table>
        <div style="font-size:12px;color:#6B5A61;-webkit-text-fill-color:#6B5A61;margin-top:3px;">Υπηρεσία: ${esc(chk.service)}</div>
        <div style="margin-top:9px;font-size:11.5px;line-height:1.9;">${badges.join('')}</div>
        <div style="margin-top:5px;font-size:11.5px;line-height:1.9;">${dataBadges.join('')}</div>
        <div style="margin-top:9px;font-size:12px;font-weight:bold;color:${chk.actions.length ? bd.color : '#0F6E56'};-webkit-text-fill-color:${chk.actions.length ? bd.color : '#0F6E56'};">${chk.actions.length ? esc(chk.actions.join(' · ')) : '✅ Όλα εντάξει — καμία ενέργεια'}</div>
      </td></tr></table>
    </td></tr>`;
  };

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="margin:0;padding:0;background-color:#FAF3F6;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF3F6;padding:24px 0;"><tr><td align="center">
  <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background-color:#FFFFFF;border-radius:18px;overflow:hidden;">
    <tr><td style="background-color:${esc(brand.color)};padding:30px 32px;text-align:center;">
      <div style="font-size:22px;font-weight:bold;color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;">${esc(brand.name)} | Daily Appointment &amp; Customer Audit</div>
      <div style="font-size:14px;color:#F7DCE8;-webkit-text-fill-color:#F7DCE8;margin-top:6px;">${esc(dayLabel)}</div>
    </td></tr>
    <tr><td style="padding:26px 32px 6px;">
      <p style="font-size:14.5px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0;">Καλημέρα,<br>Ακολουθεί ο καθημερινός έλεγχος ραντεβού και στοιχείων πελατών για σήμερα (πλήρης εκδοχή και στο συνημμένο PDF).</p>
    </td></tr>
    <tr><td style="padding:18px 32px 8px;">
      <div style="font-size:12px;font-weight:bold;letter-spacing:0.5px;color:#8A6070;-webkit-text-fill-color:#8A6070;text-transform:uppercase;margin-bottom:10px;">Σήμερα με μια ματιά</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${summaryCard(summary.total, 'Σύνολο Ραντεβού', '#FDF0F5', '#C4618A')}
        ${summaryCard(summary.gdprMissing, 'Χωρίς GDPR', '#FCEBEB', '#A32D2D')}
        ${summaryCard(summary.consentMissing, 'Χωρίς Service Consent', '#FCEBEB', '#A32D2D')}
      </tr></table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr>
        ${summaryCard(summary.consultMissing, 'Χωρίς Consultation', '#FAEEDA', '#854F0B')}
        ${summaryCard(summary.nextStepPending, 'Επόμενο Βήμα Εκκρεμεί', '#FAEEDA', '#854F0B')}
        ${summaryCard(summary.incompleteData, 'Ελλιπή Στοιχεία', '#FAEEDA', '#854F0B')}
      </tr></table>
    </td></tr>
    <tr><td style="padding:24px 32px 4px;">
      <div style="font-size:14px;font-weight:bold;color:${esc(brand.color)};-webkit-text-fill-color:${esc(brand.color)};border-bottom:2px solid ${esc(brand.color)};padding-bottom:6px;">📅 Ραντεβού Σήμερα — Ανά Πελάτη (με σειρά ώρας)</div>
    </td></tr>
    ${checks.map(patientCard).join('')}
    <tr><td style="padding:22px 32px 26px;font-size:11px;color:#A8949B;-webkit-text-fill-color:#A8949B;text-align:center;">${esc(brand.name)} · Αυτόματη καθημερινή αναφορά από το Medi360 CRM</td></tr>
  </table>
  </td></tr></table>
  </body></html>`;
}

// ── PDF (pdf-lib, ενσωματωμένη γραμματοσειρά Noto Sans για ελληνικά) ────

const RGB = {
  navy: rgb(0.055, 0.153, 0.341),
  red: rgb(0.639, 0.176, 0.176),
  amber: rgb(0.522, 0.310, 0.043),
  green: rgb(0.059, 0.431, 0.337),
  gray: rgb(0.42, 0.35, 0.38),
  black: rgb(0.13, 0.13, 0.13),
};

// Ένα-φορά-ανά-cold-start cache — δεν χρειάζεται να ξανακατέβει η
// γραμματοσειρά για κάθε κλινική στην ίδια εκτέλεση.
let notoSansBytesPromise: Promise<Uint8Array> | null = null;
function getNotoSansBytes(): Promise<Uint8Array> {
  if (!notoSansBytesPromise) {
    notoSansBytesPromise = fetch('https://raw.githubusercontent.com/yohanpanou-rgb/medi360-crm-updated/main/supabase/functions/daily-audit-report/fonts/NotoSans-Regular.ttf')
      .then((r) => { if (!r.ok) throw new Error('Font fetch failed: ' + r.status); return r.arrayBuffer(); })
      .then((buf) => new Uint8Array(buf));
  }
  return notoSansBytesPromise;
}

async function buildAuditPdf(clinicName: string, dayLabel: string, summary: { total: number; gdprMissing: number; consultMissing: number; consentMissing: number; nextStepPending: number; incompleteData: number }, checks: PatientCheck[]): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  // deno-lint-ignore no-explicit-any
  pdfDoc.registerFontkit(fontkit as any);
  const fontBytes = await getNotoSansBytes();
  // subset:false — pdf-lib's fontkit-based glyph subsetting corrupts this
  // font's glyph table (confirmed locally: with subset:true most Greek AND
  // Latin characters render as blank gaps). Embedding the whole font costs
  // ~300KB extra on the PDF, which is a non-issue for an email attachment.
  const font = await pdfDoc.embedFont(fontBytes, { subset: false });

  const MARGIN = 40;
  const PAGE_W = 595.28, PAGE_H = 841.89;
  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = () => { page = pdfDoc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; };
  const ensureSpace = (needed: number) => { if (y - needed < MARGIN) newPage(); };
  const wrapText = (text: string, size: number, maxWidth: number): string[] => {
    const words = text.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) > maxWidth && cur) { lines.push(cur); cur = w; } else { cur = test; }
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const drawLine = (text: string, x: number, size: number, color = RGB.black) => {
    page.drawText(text, { x, y, size, font, color });
  };

  drawLine(`${clinicName} — Daily Appointment & Customer Audit`, MARGIN, 16, RGB.navy);
  y -= 20;
  drawLine(dayLabel, MARGIN, 11, RGB.gray);
  y -= 22;

  drawLine(`Σύνολο ραντεβού: ${summary.total}   ·   Χωρίς GDPR: ${summary.gdprMissing}   ·   Χωρίς Consultation: ${summary.consultMissing}`, MARGIN, 9.5, RGB.gray);
  y -= 14;
  drawLine(`Χωρίς Service Consent: ${summary.consentMissing}   ·   Επόμενο Βήμα Εκκρεμεί: ${summary.nextStepPending}   ·   Ελλιπή Στοιχεία: ${summary.incompleteData}`, MARGIN, 9.5, RGB.gray);
  y -= 20;

  const contentWidth = PAGE_W - MARGIN * 2 - 16;
  for (const chk of checks) {
    const color = chk.priority === 'red' ? RGB.red : chk.priority === 'yellow' ? RGB.amber : RGB.green;
    const label = chk.priority === 'red' ? 'ΥΨΗΛΗ' : chk.priority === 'yellow' ? 'ΜΕΣΑΙΑ' : 'OK';

    // Προϋπολογισμός ύψους block ώστε να μη σκίζεται στο τέλος σελίδας.
    const badgeLines: { text: string; ok: boolean | null }[] = [];
    if (chk.gdprOk !== null) badgeLines.push({ text: chk.gdprOk ? 'GDPR: OK' : 'GDPR: Λείπει', ok: chk.gdprOk });
    if (chk.consultationDone !== null) badgeLines.push({ text: chk.consultationDone ? `Consultation: Έγινε${chk.consultDate ? ' (' + chk.consultDate + ')' : ''}` : 'Consultation: δεν έχει γίνει ποτέ', ok: chk.consultationDone });
    if (chk.consentGroup) {
      if (chk.consentOk !== null) badgeLines.push({ text: `Συναίνεση ${CONSENT_GROUP_LABEL[chk.consentGroup]}: ${chk.consentOk ? 'OK' : 'Λείπει'}`, ok: chk.consentOk });
    } else {
      badgeLines.push({ text: 'Συναίνεση Υπηρεσίας: N/A', ok: null });
    }
    if (chk.nextStepPending !== null) badgeLines.push({ text: chk.nextStepPending ? 'Επόμενο Βήμα: Δεν έχει κλειστεί' : 'Επόμενο Βήμα: Κλεισμένο', ok: !chk.nextStepPending });
    badgeLines.push({ text: `Email: ${chk.missingFields.includes('Email') ? 'Λείπει' : 'OK'}  ·  Τηλ: ${chk.missingFields.includes('Τηλέφωνο') ? 'Λείπει' : 'OK'}  ·  Πόλη: ${chk.missingFields.includes('Πόλη') ? 'Λείπει' : 'OK'}  ·  Γέννηση: ${chk.missingFields.includes('Ημ. Γέννησης') ? 'Λείπει' : 'OK'}`, ok: chk.missingFields.length === 0 });

    const actionText = chk.actions.length ? 'Ενέργειες: ' + chk.actions.join(' · ') : 'Όλα εντάξει — καμία ενέργεια';
    const actionLines = wrapText(actionText, 9.5, contentWidth);

    const blockHeight = 18 + badgeLines.length * 13 + actionLines.length * 12 + 14;
    ensureSpace(blockHeight);

    const blockTop = y;
    page.drawRectangle({ x: MARGIN, y: blockTop - blockHeight + 8, width: 4, height: blockHeight - 8, color });

    const nameLine = `${chk.time} — ${chk.name}${chk.isNew ? '  [NEW]' : ''}`;
    drawLine(nameLine, MARGIN + 12, 11, RGB.black);
    const labelWidth = font.widthOfTextAtSize(label, 9.5);
    page.drawText(label, { x: PAGE_W - MARGIN - labelWidth, y, size: 9.5, font, color });
    y -= 14;
    drawLine(`Υπηρεσία: ${chk.service}`, MARGIN + 12, 9.5, RGB.gray);
    y -= 13;

    for (const b of badgeLines) {
      const c = b.ok === false ? RGB.red : b.ok === true ? RGB.green : RGB.gray;
      drawLine('•', MARGIN + 12, 9.5, c);
      drawLine(b.text, MARGIN + 22, 9.5, c);
      y -= 13;
    }
    for (const line of actionLines) {
      drawLine(line, MARGIN + 12, 9.5, chk.actions.length ? color : RGB.green);
      y -= 12;
    }
    y -= 10;
  }

  return await pdfDoc.save();
}
