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
      if (!phone || !row.date) return { messageId: row.messageId, ok: false, reason: 'parse' };

      const [d, m, y] = row.date.split('/');
      const [h, mi] = (row.time || '09:00').split(':');
      if (!d || !m || !y) return { messageId: row.messageId, ok: false, reason: 'bad_date' };
      const localTs = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${(h || '09').padStart(2, '0')}:${(mi || '00').padStart(2, '0')}:00`;

      let patientId: string | null = null;
      const { data: existingPatients } = await supabase
        .from('patients').select('id')
        .eq('clinic_id', cid).ilike('phone', `%${phone}%`).limit(1);
      if (existingPatients && existingPatients.length) {
        patientId = existingPatients[0].id;
      } else {
        const { data: newPt, error: insPtErr } = await supabase
          .from('patients')
          .insert({ clinic_id: cid, full_name: name, phone, status: 'active', source: 'booking247' })
          .select('id').single();
        if (insPtErr) return { messageId: row.messageId, ok: false, reason: insPtErr.message };
        patientId = newPt?.id || null;
      }
      if (!patientId) return { messageId: row.messageId, ok: false, reason: 'no_patient' };

      const { data: existingAppt } = await supabase.rpc('match_appt_by_local_time', {
        p_clinic_id: cid, p_patient_id: patientId, p_local_ts: localTs,
      });
      if (existingAppt && existingAppt.length) return { messageId: row.messageId, ok: true, reason: 'duplicate' };

      const { error: insApptErr } = await supabase.from('appointments').insert({
        clinic_id: cid, patient_id: patientId,
        service_name: row.service || '', start_time: localTs,
        duration_minutes: row.duration || 60, status: 'confirmed',
        notes: row.staff ? `Προσωπικό: ${row.staff}` : '',
      });
      if (insApptErr) return { messageId: row.messageId, ok: false, reason: insApptErr.message };
      return { messageId: row.messageId, ok: true, reason: 'created' };
    } catch (e) {
      return { messageId: row.messageId, ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }));

  return json({ ok: true, results });
});
