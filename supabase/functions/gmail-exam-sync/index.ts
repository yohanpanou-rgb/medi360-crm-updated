// Supabase Edge Function — 📥 Αυτόματη εισαγωγή εξετάσεων από email πελάτη.
//
// Σαρώνει το inbox του yourbeautyline@gmail.com (ίδιο OAuth token με το
// gmail-auto-sync — GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN, ήδη υπάρχουν) για
// emails με συνημμένο. Αν ο αποστολέας ταυτίζεται με το email καταχωρημένου
// ασθενή, τα συνημμένα (εικόνες/PDF) μπαίνουν αυτόματα στο "Εξετάσεις" της
// κάρτας του — αν δεν υπάρχουν ήδη (ίδιο όνομα αρχείου) — και ζητείται
// αμέσως AI ταξινόμηση (classify-exam, με το κοινό cron secret).
//
// Κάθε email σημαδεύεται με το label "medi360-exam-synced" μόλις υποστεί
// επεξεργασία (βρέθηκε ή όχι αντιστοιχία ασθενή) — δεν ξαναδιαβάζεται.
//
// Scheduled κάθε 15 λεπτά (βλ. supabase/create_gmail_exam_sync.sql).
//
// Deploy with:
//   supabase functions deploy gmail-exam-sync --no-verify-jwt
// Required secrets (ήδη υπάρχουν, ίδια με gmail-auto-sync / appointment-automations):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//   BIRTHDAY_CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-cron-secret',
};
const SYNCED_LABEL = 'medi360-exam-synced';
const ELIGIBLE_MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MIN_ATTACHMENT_BYTES = 4000; // αγνοεί μικρά inline logo/υπογραφές email

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

async function getToken(): Promise<string> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID')!,
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
      refresh_token: Deno.env.get('GOOGLE_REFRESH_TOKEN')!,
      grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Token failed: ' + JSON.stringify(d));
  return d.access_token;
}

async function gmailSearch(token: string, q: string, max = 50): Promise<{ id: string }[]> {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const d = await r.json();
  return (d.messages || []) as { id: string }[];
}

// deno-lint-ignore no-explicit-any
async function gmailGetFull(token: string, id: string): Promise<any> {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: 'Bearer ' + token } });
  return r.json();
}

async function getOrCreateLabelId(token: string): Promise<string> {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  const existing = (d.labels || []).find((l: { name: string }) => l.name.toLowerCase() === SYNCED_LABEL.toLowerCase());
  if (existing) return existing.id;
  const cr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: SYNCED_LABEL, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
  });
  const cd = await cr.json();
  if (!cd.id) throw new Error('Label creation failed: ' + JSON.stringify(cd));
  return cd.id;
}

async function markSynced(token: string, id: string, labelId: string) {
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
}

function headerValue(headers: { name: string; value: string }[], name: string): string {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractEmail(fromHeader: string): string {
  const m = /<([^>]+)>/.exec(fromHeader);
  const addr = (m ? m[1] : fromHeader).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : '';
}

interface AttachmentPart { filename: string; mimeType: string; attachmentId: string; size: number }

// deno-lint-ignore no-explicit-any
function collectAttachments(payload: any, out: AttachmentPart[] = []): AttachmentPart[] {
  if (!payload) return out;
  const filename = payload.filename;
  const attId = payload.body && payload.body.attachmentId;
  const size = (payload.body && payload.body.size) || 0;
  if (filename && attId && ELIGIBLE_MEDIA_TYPES.includes(payload.mimeType) && size >= MIN_ATTACHMENT_BYTES) {
    out.push({ filename, mimeType: payload.mimeType, attachmentId: attId, size });
  }
  if (payload.parts) for (const p of payload.parts) collectAttachments(p, out);
  return out;
}

function decodeBase64Url(data: string): Uint8Array {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function getAttachmentBytes(token: string, messageId: string, attachmentId: string): Promise<Uint8Array> {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const d = await r.json();
  if (!d.data) throw new Error('Attachment download failed: ' + JSON.stringify(d));
  return decodeBase64Url(d.data);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const secret = Deno.env.get('BIRTHDAY_CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'Unauthorized' }, 401);

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const token = await getToken();

    const { data: clinicRow } = await supabase.from('clinics').select('id').ilike('name', '%Beauty Line%').limit(1).single();
    const cid = clinicRow?.id;
    if (!cid) return json({ error: 'Clinic not found' }, 500);

    const labelId = await getOrCreateLabelId(token);
    const results = { scanned: 0, imported: 0, skipped_no_patient: 0, skipped_no_attachment: 0, skipped_duplicate: 0, errors: 0 };

    const msgs = await gmailSearch(token, `has:attachment -label:${SYNCED_LABEL}`, 50);
    results.scanned = msgs.length;

    for (const { id: messageId } of msgs) {
      try {
        const msg = await gmailGetFull(token, messageId);
        const headers = (msg.payload && msg.payload.headers) || [];
        const senderEmail = extractEmail(headerValue(headers, 'From'));
        if (!senderEmail) { await markSynced(token, messageId, labelId); continue; }

        const { data: patients } = await supabase.from('patients')
          .select('id').eq('clinic_id', cid).ilike('email', senderEmail).limit(1);
        const patientId = patients && patients[0] && patients[0].id;
        if (!patientId) { results.skipped_no_patient++; await markSynced(token, messageId, labelId); continue; }

        const attachments = collectAttachments(msg.payload);
        if (!attachments.length) { results.skipped_no_attachment++; await markSynced(token, messageId, labelId); continue; }

        const dateHeader = headerValue(headers, 'Date');
        const parsedDate = dateHeader ? new Date(dateHeader) : new Date();
        const examDate = (isNaN(parsedDate.getTime()) ? new Date() : parsedDate).toISOString().slice(0, 10);

        for (const att of attachments) {
          const { data: existing } = await supabase.from('patient_exams')
            .select('id').eq('patient_id', patientId).eq('file_name', att.filename).limit(1);
          if (existing && existing.length) { results.skipped_duplicate++; continue; }

          const bytes = await getAttachmentBytes(token, messageId, att.attachmentId);
          const safeName = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const path = `${cid}/${patientId}/${Date.now()}_${safeName}`;
          const { error: upErr } = await supabase.storage.from('patient-exams').upload(path, bytes, { contentType: att.mimeType });
          if (upErr) { results.errors++; continue; }

          const { data: examRow, error: insErr } = await supabase.from('patient_exams').insert({
            clinic_id: cid, patient_id: patientId, storage_path: path, file_name: att.filename,
            exam_date: examDate, uploaded_by: null,
          }).select('id').single();
          if (insErr || !examRow) { results.errors++; continue; }
          results.imported++;

          // Fire-and-forget AI ταξινόμηση — αποτυχία εδώ δεν μπλοκάρει την
          // εισαγωγή, το exam απλά μένει 'pending' και ταξινομείται χειροκίνητα.
          fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/classify-exam`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
            body: JSON.stringify({ exam_id: examRow.id }),
          }).catch(() => {});
        }

        await markSynced(token, messageId, labelId);
      } catch (_e) {
        results.errors++;
        await markSynced(token, messageId, labelId).catch(() => {});
      }
    }

    return json({ ok: true, results });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});
