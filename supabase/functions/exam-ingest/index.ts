// Supabase Edge Function — receives pre-fetched exam attachments pushed from
// a Google Apps Script running under the clinic's own Gmail account (see
// google-apps-script/booking247-sync.gs → syncExamAttachments()).
//
// Why this exists (same reason as booking247-ingest): reading Gmail directly
// from a Supabase Edge Function needs a Google OAuth client, whose refresh
// token Google auto-expires every ~7 days for apps left in "Testing"
// publishing status — impractical to avoid for a personal (non-Workspace)
// Gmail account. Apps Script bound to the account owner's own Gmail doesn't
// have that problem (authorize once, keeps working indefinitely), so the
// email reading + attachment extraction happens there instead. This
// function only does the patient-matching + storage + DB part, exactly like
// booking247-ingest does for appointments.
//
// Deploy with:
//   supabase functions deploy exam-ingest --no-verify-jwt
// (No logged-in user calls this — Apps Script authenticates with a shared
// secret header instead of a Supabase JWT.)
//
// Required secrets:
//   EXAM_INGEST_SECRET — any random string; must match the value pasted
//                        into the Apps Script's EXAM_INGEST_SECRET.
//   ANTHROPIC_API_KEY, BIRTHDAY_CRON_SECRET — already set (used to trigger
//                        classify-exam after each successful import).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-secret',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface IngestRow {
  messageId: string; // Gmail message id — echoed back so Apps Script knows which emails to label as synced
  senderEmail: string;
  filename: string;
  mimeType: string;
  dataBase64: string;
  dateIso?: string; // ημερομηνία email (YYYY-MM-DD) — γίνεται exam_date, fallback στη σημερινή
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const secret = Deno.env.get('EXAM_INGEST_SECRET');
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
      const senderEmail = (row.senderEmail || '').trim().toLowerCase();
      if (!senderEmail || !row.filename || !row.dataBase64) {
        return { messageId: row.messageId, filename: row.filename, ok: false, reason: 'bad_row' };
      }

      const { data: patients } = await supabase.from('patients')
        .select('id').eq('clinic_id', cid).ilike('email', senderEmail).limit(1);
      const patientId = patients && patients[0] && patients[0].id;
      if (!patientId) return { messageId: row.messageId, filename: row.filename, ok: false, reason: 'no_patient' };

      const { data: existing } = await supabase.from('patient_exams')
        .select('id').eq('patient_id', patientId).eq('file_name', row.filename).limit(1);
      if (existing && existing.length) return { messageId: row.messageId, filename: row.filename, ok: true, reason: 'duplicate' };

      const bytes = base64ToBytes(row.dataBase64);
      const safeName = row.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${cid}/${patientId}/${Date.now()}_${safeName}`;
      const { error: upErr } = await supabase.storage.from('patient-exams').upload(path, bytes, { contentType: row.mimeType });
      if (upErr) return { messageId: row.messageId, filename: row.filename, ok: false, reason: upErr.message };

      const examDate = row.dateIso && /^\d{4}-\d{2}-\d{2}$/.test(row.dateIso) ? row.dateIso : new Date().toISOString().slice(0, 10);
      const { data: examRow, error: insErr } = await supabase.from('patient_exams').insert({
        clinic_id: cid, patient_id: patientId, storage_path: path, file_name: row.filename,
        exam_date: examDate, uploaded_by: null,
      }).select('id').single();
      if (insErr || !examRow) return { messageId: row.messageId, filename: row.filename, ok: false, reason: insErr?.message || 'insert_failed' };

      // Fire-and-forget AI ταξινόμηση — αποτυχία εδώ δεν μπλοκάρει την
      // εισαγωγή, το exam απλά μένει 'pending' και ταξινομείται χειροκίνητα.
      const cronSecret = Deno.env.get('BIRTHDAY_CRON_SECRET');
      if (cronSecret) {
        fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/classify-exam`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
          body: JSON.stringify({ exam_id: examRow.id }),
        }).catch(() => {});
      }

      return { messageId: row.messageId, filename: row.filename, ok: true, reason: 'created' };
    } catch (e) {
      return { messageId: row.messageId, filename: row.filename, ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }));

  return json({ ok: true, results });
});
