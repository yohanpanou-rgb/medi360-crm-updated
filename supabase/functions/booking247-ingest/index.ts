// Supabase Edge Function — receives pre-parsed Booking247 appointment rows
// pushed from a Google Apps Script running under the clinic's own Gmail
// account (see google-apps-script/booking247-sync.gs).
//
// Why this exists: gmail-auto-sync (the previous Gmail-reading function)
// uses a Google OAuth client, whose refresh token Google auto-expires every
// ~7 days for apps left in "Testing" publishing status — impractical to
// avoid for a personal (non-Workspace) Gmail account, since publishing to
// Production with the gmail.readonly scope requires Google verification.
// Apps Script bound to the account owner's own Gmail doesn't have that
// problem (authorize once, keeps working indefinitely), so the email
// reading + parsing now happens there instead. This function only does the
// patient-matching + appointment-creation part — the same job
// gmail-auto-sync did after parsing, using the same safe conventions
// (exact phone match with international-prefix normalization, uppercase
// patient names, match_appt_by_local_time for duplicate detection).
//
// Deploy with:
//   supabase functions deploy booking247-ingest --no-verify-jwt
// (No logged-in user calls this — Apps Script authenticates with a shared
// secret header instead of a Supabase JWT.)
//
// Required secret (set via `supabase secrets set`):
//   BOOKING247_INGEST_SECRET — any random string; must match the value
//                              pasted into the Apps Script's INGEST_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-secret',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function normalizePhone(p: string | null | undefined): string {
  if (!p) return '';
  let digits = String(p).replace(/[^\d]/g, '');
  if (digits.startsWith('00') && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith('30') && digits.length > 10) digits = digits.slice(2);
  return digits.replace(/^0+/, '');
}

function normalizePatientName(s: string | null | undefined): string {
  return (s || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/́/g, '')
    .normalize('NFC');
}

interface IngestRow {
  messageId: string; // Gmail message id — echoed back so Apps Script knows which emails to label as synced
  name: string;
  phone: string;
  date: string; // DD/MM/YYYY, as written by Booking247
  time: string; // HH:MM
  service: string;
  staff?: string;
  duration?: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const secret = Deno.env.get('BOOKING247_INGEST_SECRET');
  if (secret && req.headers.get('x-ingest-secret') !== secret) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: { rows?: IngestRow[] } = {};
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const rows = body.rows || [];
  if (!rows.length) return json({ ok: true, results: [] });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: clinic, error: clinicErr } = await supabase
    .from('clinics').select('id').ilike('name', '%Beauty Line%').limit(1).single();
  if (clinicErr || !clinic) return json({ error: 'Clinic not found' }, 500);
  const cid = clinic.id as string;

  const results = await Promise.all(rows.map(async (row) => {
    try {
      const phone = normalizePhone(row.phone);
      const name = normalizePatientName(row.name);
      if ((!phone && !name) || !row.date) return { messageId: row.messageId, ok: false, reason: 'parse' };

      const [d, m, y] = row.date.split('/');
      const [h, mi] = (row.time || '09:00').split(':');
      if (!d || !m || !y) return { messageId: row.messageId, ok: false, reason: 'bad_date' };
      const localTs = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${(h || '09').padStart(2, '0')}:${(mi || '00').padStart(2, '0')}:00`;

      let patientId: string | null = null;
      let matchedName = '';
      if (phone) {
        // ΑΚΡΙΒΕΣ ταίριασμα τηλεφώνου: το ilike φέρνει υποψηφίους, αλλά κρατάμε
        // ΜΟΝΟ όσους έχουν ακριβώς ίδιο κανονικοποιημένο νούμερο — ένα χαλασμένο
        // 12ψήφιο (π.χ. "695180422309") που ΠΕΡΙΕΧΕΙ το νούμερο της κράτησης δεν
        // πρέπει να "κλέβει" το ραντεβού. Ανάμεσα σε πολλούς (οικογένεια με κοινό
        // κινητό) προτιμάται αυτός που ταιριάζει και στο όνομα της κράτησης.
        const { data: candidates } = await supabase
          .from('patients').select('id, full_name, phone')
          .eq('clinic_id', cid).ilike('phone', `%${phone.slice(-9)}%`).limit(20);
        const exact = (candidates || []).filter((p) => normalizePhone(p.phone) === phone);
        if (exact.length) {
          // Βαθμολόγηση με πλήθος κοινών λέξεων ονόματος: σε οικογένεια με κοινό
          // κινητό ΚΑΙ κοινό επώνυμο ("ΜΑΡΙΑ ΓΕΩΡΓΙΟΥ"/"ΕΛΕΝΗ ΓΕΩΡΓΙΟΥ"), η
          // κράτηση "Ελένη Γεωργίου" πρέπει να πάει στην Ελένη (2 κοινές λέξεις),
          // όχι στην πρώτη τυχούσα με ίδιο επώνυμο (1 κοινή).
          const words = name.split(/\s+/).filter((w) => w.length >= 3);
          const score = (p: { full_name: string }) => {
            const pn = normalizePatientName(p.full_name);
            return words.filter((w) => pn.includes(w)).length;
          };
          const chosen = exact.slice().sort((a, b) => score(b) - score(a))[0];
          patientId = chosen.id;
          matchedName = normalizePatientName(chosen.full_name);
        }
      } else {
        // Κράτηση χωρίς τηλέφωνο: ταίριασμα με ακριβές (κανονικοποιημένο) όνομα —
        // ανεξάρτητα από σειρά λέξεων ("ΠΛΑΤΑΚΗ ΑΝΤΩΝΙΑ" = "ΑΝΤΩΝΙΑ ΠΛΑΤΑΚΗ") —
        // αντί να χάνεται σιωπηλά η κράτηση.
        const words = name.split(/\s+/).filter(Boolean);
        const nameKey = words.slice().sort().join(' ');
        const longest = words.slice().sort((a, b) => b.length - a.length)[0] || '';
        const { data: byName } = await supabase
          .from('patients').select('id, full_name')
          .eq('clinic_id', cid).ilike('full_name', `%${longest}%`).limit(10);
        const hit = (byName || []).find((p) =>
          normalizePatientName(p.full_name).split(/\s+/).filter(Boolean).sort().join(' ') === nameKey);
        if (hit) { patientId = hit.id; matchedName = normalizePatientName(hit.full_name); }
      }
      if (!patientId) {
        const { data: newPt, error: insPtErr } = await supabase
          .from('patients')
          .insert({ clinic_id: cid, full_name: name || 'ΑΓΝΩΣΤΟ ΟΝΟΜΑ', phone, status: 'active', source: 'booking247' })
          .select('id').single();
        if (insPtErr) return { messageId: row.messageId, ok: false, reason: insPtErr.message };
        patientId = newPt?.id || null;
        matchedName = name;
      }
      if (!patientId) return { messageId: row.messageId, ok: false, reason: 'no_patient' };

      const { data: existingAppt } = await supabase.rpc('match_appt_by_local_time', {
        p_clinic_id: cid, p_patient_id: patientId, p_local_ts: localTs,
      });
      if (existingAppt && existingAppt.length) return { messageId: row.messageId, ok: true, reason: 'duplicate' };

      // Αν το όνομα της κράτησης διαφέρει από την καρτέλα που ταίριαξε (π.χ.
      // κοινό κινητό οικογένειας), κράτα το στο ραντεβού ώστε στο Πρόγραμμα να
      // φαίνεται τι κλείστηκε πραγματικά — σε δική του γραμμή, για να μην
      // μπερδεύεται με το "Προσωπικό: ..." που διαβάζουν ημερολόγιο/στατιστικά.
      const nameDiffers = name && matchedName && normalizePatientName(name) !== matchedName &&
        !name.split(/\s+/).some((w) => w.length >= 3 && matchedName.includes(w));
      const noteLines = [
        row.staff ? `Προσωπικό: ${row.staff}` : '',
        nameDiffers ? `Όνομα κράτησης: ${name}` : '',
      ].filter(Boolean);
      const { error: insApptErr } = await supabase.from('appointments').insert({
        clinic_id: cid, patient_id: patientId,
        service_name: row.service || '', start_time: localTs,
        duration_minutes: row.duration || 60, status: 'confirmed',
        notes: noteLines.join('\n'),
      });
      if (insApptErr) return { messageId: row.messageId, ok: false, reason: insApptErr.message };
      return { messageId: row.messageId, ok: true, reason: 'created' };
    } catch (e) {
      return { messageId: row.messageId, ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }));

  return json({ ok: true, results });
});
