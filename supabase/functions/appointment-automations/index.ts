// Supabase Edge Function — 📬 Αυτοματισμοί Ραντεβού (Beauty Line).
//
// Δύο δουλειές, μία σάρωση (καλείται ωριαία από pg_cron):
//  1. ΑΙΤΗΜΑ ΕΠΙΒΕΒΑΙΩΣΗΣ: ραντεβού ΚΛΕΙΣΜΕΝΑ (booked) που μπαίνουν στο
//     48ωρο πριν την ώρα τους → email με κουμπί «Επιβεβαιώνω το ραντεβού»
//     (link στο appointment-confirm). Χωρίς email πελάτη → log 'no_email'
//     ώστε η γραμματεία να τηλεφωνήσει (Dashboard widget).
//  2. ΟΔΗΓΙΕΣ ΠΡΙΝ/ΜΕΤΑ: ραντεβού ΕΠΙΒΕΒΑΙΩΜΕΝΑ (confirmed) μελλοντικά που
//     δεν έχουν πάρει οδηγίες στον τρέχοντα κύκλο → email με τις οδηγίες του
//     Instruction Set της υπηρεσίας (πίνακες instruction_sets +
//     service_instruction_map). Υπηρεσία χωρίς σετ → log 'no_set' (άκυρο noise
//     δεν στέλνεται).
//
// Idempotency: μοναδικό (appointment_id, automation_type, cycle) με
// cycle = start_time — αλλαγή ώρας ραντεβού ξεκινά αυτόματα νέο κύκλο.
//
// Χειροκίνητες ενέργειες (από το CRM, με login): POST body
// {action:'resend_confirmation'|'resend_instructions', appointment_id} —
// στέλνει ξανά αγνοώντας το idempotency (καταγράφεται με channel 'manual').
//
// Deploy with:
//   supabase functions deploy appointment-automations --no-verify-jwt
// (in-code auth: x-cron-secret για το cron Ή Supabase JWT για χειροκίνητες)
// Secrets: BIRTHDAY_CRON_SECRET (κοινό cron secret), GOOGLE_CLIENT_ID,
//   GOOGLE_CLIENT_SECRET, BL_REFRESH_TOKEN — υπάρχουν ήδη.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SENDER = 'yourbeautyline@gmail.com';
const CONFIRM_URL = 'https://kfidxwqgsaisbdgucsok.supabase.co/functions/v1/appointment-confirm';

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

function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

async function sendEmail(token: string, to: string, subject: string, html: string) {
  const headerLines = [
    `From: Beauty Line by Lina Panou <${SENDER}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
  ];
  const message = headerLines.join('\r\n') + '\r\n\r\n' + b64utf8(html);
  const raw = b64utf8(message).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const out = await res.json();
  if (out.error) throw new Error(JSON.stringify(out.error));
  return out.id as string;
}

// Ίδια κανονικοποίηση με το index.html (normalizeGreek): πεζά + χωρίς τόνους —
// έτσι το service_name του ραντεβού ταιριάζει με τον κατάλογο υπηρεσιών.
function normalizeGreek(s: string): string {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

function firstName(full: string): string {
  const w = (full || '').trim().split(/\s+/)[0] || '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function athensDT(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Athens' })
    + ' στις ' + d.toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Athens' });
}

// ── Beauty Line email templates (ίδιο ύφος με τα υπόλοιπα: solid hex +
// -webkit-text-fill-color για iPhone dark mode) ──
function shell(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background-color:#FAF3F6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF3F6;padding:24px 0;"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#FFFFFF;border-radius:18px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
      ${inner}
      <tr><td style="padding:0 26px 22px;font-size:11.5px;color:#8A6070;-webkit-text-fill-color:#8A6070;text-align:center;">Beauty Line by Lina Panou</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function confirmationEmailHtml(name: string, service: string, whenStr: string, confirmLink: string): string {
  return shell(`
      <tr><td style="background-color:#C4618A;padding:28px 30px;text-align:center;">
        <div style="font-size:36px;line-height:1;">📅</div>
        <div style="font-size:21px;font-weight:bold;color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;margin-top:8px;">Επιβεβαίωση Ραντεβού</div>
      </td></tr>
      <tr><td style="padding:28px 30px;">
        <p style="font-size:15px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 16px;">Αγαπητή/έ <b>${esc(name)}</b>,</p>
        <p style="font-size:15px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 18px;">Έχετε προγραμματισμένο ραντεβού:</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF0F5;border-radius:14px;"><tr><td style="padding:18px 22px;text-align:center;">
          <div style="font-size:16px;font-weight:bold;color:#333333;-webkit-text-fill-color:#333333;">${esc(service)}</div>
          <div style="font-size:14px;color:#8A6070;-webkit-text-fill-color:#8A6070;margin-top:6px;">${esc(whenStr)}</div>
        </td></tr></table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:22px 0 6px;">
          <a href="${esc(confirmLink)}" style="display:inline-block;background-color:#0F6E56;color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;font-size:15px;font-weight:bold;text-decoration:none;padding:14px 34px;border-radius:30px;">✅ Επιβεβαιώνω το ραντεβού</a>
        </td></tr></table>
        <p style="font-size:13px;line-height:1.7;color:#8A6070;-webkit-text-fill-color:#8A6070;margin:14px 0 0;text-align:center;">Αν η ώρα δεν σας εξυπηρετεί ή θέλετε αλλαγή, απαντήστε σε αυτό το email ή τηλεφωνήστε μας.</p>
      </td></tr>`);
}

function instructionsEmailHtml(name: string, service: string, whenStr: string, pre: string, post: string): string {
  const block = (title: string, text: string, color: string, bg: string) => text ? `
        <div style="font-size:14px;font-weight:bold;color:${color};-webkit-text-fill-color:${color};margin:18px 0 8px;">${title}</div>
        <div style="background-color:${bg};border-radius:12px;padding:14px 18px;font-size:13.5px;line-height:1.8;color:#333333;-webkit-text-fill-color:#333333;white-space:pre-line;">${esc(text)}</div>` : '';
  return shell(`
      <tr><td style="background-color:#C4618A;padding:28px 30px;text-align:center;">
        <div style="font-size:36px;line-height:1;">📋</div>
        <div style="font-size:21px;font-weight:bold;color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;margin-top:8px;">Οδηγίες για το ραντεβού σας</div>
      </td></tr>
      <tr><td style="padding:28px 30px;">
        <p style="font-size:15px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 14px;">Αγαπητή/έ <b>${esc(name)}</b>,</p>
        <p style="font-size:14.5px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 6px;">Το ραντεβού σας για <b>${esc(service)}</b> (${esc(whenStr)}) έχει επιβεβαιωθεί. Για την καλύτερη προετοιμασία και φροντίδα σας:</p>
        ${block('🌿 Πριν από τη θεραπεία', pre, '#0F6E56', '#E1F5EE')}
        ${block('💛 Μετά τη θεραπεία', post, '#854F0B', '#FAEEDA')}
        <p style="font-size:13px;line-height:1.7;color:#8A6070;-webkit-text-fill-color:#8A6070;margin:18px 0 0;">Για οποιαδήποτε απορία, απαντήστε σε αυτό το email ή τηλεφωνήστε μας. Σας περιμένουμε! ✨</p>
      </td></tr>`);
}

interface Appt {
  id: string; clinic_id: string; patient_id: string; status: string;
  start_time: string; service_name?: string;
  patients?: { full_name?: string; email?: string } | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── Auth: cron secret Ή συνδεδεμένος χρήστης του CRM (χειροκίνητες ενέργειες) ──
  const secret = Deno.env.get('BIRTHDAY_CRON_SECRET');
  const isCron = !!secret && req.headers.get('x-cron-secret') === secret;
  let body: { action?: string; appointment_id?: string } = {};
  try { body = await req.json(); } catch { /* κενό body από cron */ }

  if (!isCron) {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (!profile || !['super_admin', 'clinic_admin', 'receptionist', 'therapist'].includes(profile.role)) {
      return json({ error: 'Forbidden' }, 403);
    }
  }

  try {
    const token: { v: string | null } = { v: null };
    const gmail = async () => { if (!token.v) token.v = await getGmailAccessToken(); return token.v; };
    const results: Record<string, number> = { confirmations: 0, instructions: 0, no_email: 0, no_set: 0, errors: 0 };

    const log = async (a: Appt, type: string, channel: string, status: string, extra?: Record<string, unknown>) => {
      await supabase.from('communication_log').insert({
        clinic_id: a.clinic_id, appointment_id: a.id, patient_id: a.patient_id,
        automation_type: type, channel, recipient: (a.patients && a.patients.email) || null,
        cycle: a.start_time, status, ...(extra || {}),
      });
    };
    const alreadyDone = async (a: Appt, type: string) => {
      const { data } = await supabase.from('communication_log').select('id')
        .eq('appointment_id', a.id).eq('automation_type', type).eq('cycle', a.start_time)
        .in('status', ['sent', 'no_email', 'no_set']).limit(1);
      return !!(data && data.length);
    };

    // ── Φόρτωση instruction sets + καταλόγου για την αντιστοίχιση ──
    const { data: sets } = await supabase.from('instruction_sets').select('*').eq('active', true);
    const { data: maps } = await supabase.from('service_instruction_map').select('service_id,instruction_set_id');
    const { data: services } = await supabase.from('services').select('id,name');
    const setForService = (serviceName: string) => {
      const want = normalizeGreek(serviceName || '');
      if (!want) return null;
      const svc = (services || []).find((s) => normalizeGreek(s.name) === want);
      if (!svc) return null;
      const m = (maps || []).find((x) => x.service_id === svc.id);
      if (!m) return null;
      return (sets || []).find((x) => x.id === m.instruction_set_id) || null;
    };

    const sendConfirmation = async (a: Appt, channel = 'email') => {
      const email = a.patients && a.patients.email;
      if (!email || !String(email).includes('@')) { await log(a, 'confirmation_request', channel, 'no_email'); results.no_email++; return; }
      const ts = Math.floor(new Date(a.start_time).getTime() / 1000);
      const link = `${CONFIRM_URL}?id=${a.id}&ts=${ts}`;
      const html = confirmationEmailHtml(firstName((a.patients && a.patients.full_name) || ''), a.service_name || 'την υπηρεσία σας', athensDT(a.start_time), link);
      try {
        const msgId = await sendEmail(await gmail(), String(email), '📅 Επιβεβαιώστε το ραντεβού σας — Beauty Line', html);
        await log(a, 'confirmation_request', channel, 'sent', { metadata: { gmail_id: msgId } });
        results.confirmations++;
      } catch (e) {
        await log(a, 'confirmation_request', channel, 'failed', { error: e instanceof Error ? e.message : String(e) });
        results.errors++;
      }
    };

    const sendInstructions = async (a: Appt, channel = 'email') => {
      const set = setForService(a.service_name || '');
      if (!set) { await log(a, 'instructions', channel, 'no_set'); results.no_set++; return; }
      const email = a.patients && a.patients.email;
      if (!email || !String(email).includes('@')) { await log(a, 'instructions', channel, 'no_email', { metadata: { instruction_set: set.name } }); results.no_email++; return; }
      const html = instructionsEmailHtml(firstName((a.patients && a.patients.full_name) || ''), a.service_name || '', athensDT(a.start_time), set.pre_instructions || '', set.post_instructions || '');
      try {
        const msgId = await sendEmail(await gmail(), String(email), '📋 Οδηγίες για το ραντεβού σας — Beauty Line', html);
        await log(a, 'instructions', channel, 'sent', { metadata: { gmail_id: msgId, instruction_set: set.name } });
        results.instructions++;
      } catch (e) {
        await log(a, 'instructions', channel, 'failed', { error: e instanceof Error ? e.message : String(e) });
        results.errors++;
      }
    };

    // ── Χειροκίνητη ενέργεια από το CRM ──
    if (body.action && body.appointment_id) {
      const { data: appt } = await supabase.from('appointments')
        .select('id,clinic_id,patient_id,status,start_time,service_name,patients(full_name,email)')
        .eq('id', body.appointment_id).single();
      if (!appt) return json({ error: 'Appointment not found' }, 404);
      const a = appt as unknown as Appt;
      if (body.action === 'resend_confirmation') await sendConfirmation(a, 'manual');
      else if (body.action === 'resend_instructions') await sendInstructions(a, 'manual');
      else return json({ error: 'Unknown action' }, 400);
      return json({ ok: true, results });
    }
    if (!isCron) return json({ error: 'Missing action' }, 400);

    // ── Σάρωση cron ──
    const now = new Date();
    const in48h = new Date(now.getTime() + 48 * 3600 * 1000);
    const horizon = new Date(now.getTime() + 14 * 86400 * 1000);

    // 1) ΚΛΕΙΣΜΕΝΑ μέσα στο 48ωρο → αίτημα επιβεβαίωσης
    const { data: bookedRows } = await supabase.from('appointments')
      .select('id,clinic_id,patient_id,status,start_time,service_name,patients(full_name,email)')
      .eq('status', 'booked').gte('start_time', now.toISOString()).lte('start_time', in48h.toISOString());
    for (const row of (bookedRows || []) as unknown as Appt[]) {
      if (await alreadyDone(row, 'confirmation_request')) continue;
      await sendConfirmation(row);
    }

    // 2) ΕΠΙΒΕΒΑΙΩΜΕΝΑ μελλοντικά χωρίς οδηγίες στον κύκλο τους → οδηγίες
    //    (πιάνει και τις χειροκίνητες επιβεβαιώσεις από τη γραμματεία και τα
    //    ≤48h ραντεβού που μπήκαν κατευθείαν ΕΠΙΒΕΒΑΙΩΜΕΝΑ)
    const { data: confRows } = await supabase.from('appointments')
      .select('id,clinic_id,patient_id,status,start_time,service_name,patients(full_name,email)')
      .eq('status', 'confirmed').gte('start_time', now.toISOString()).lte('start_time', horizon.toISOString());
    for (const row of (confRows || []) as unknown as Appt[]) {
      if (await alreadyDone(row, 'instructions')) continue;
      await sendInstructions(row);
    }

    return json({ ok: true, results });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});
