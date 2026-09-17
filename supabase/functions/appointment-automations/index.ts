// Supabase Edge Function — 📬 Αυτοματισμοί Ραντεβού (Beauty Line).
//
// Καλείται ανά 15 λεπτά από pg_cron:
//  1. ΑΙΤΗΜΑ ΕΠΙΒΕΒΑΙΩΣΗΣ: ραντεβού ΚΛΕΙΣΜΕΝΑ (booked) που μπαίνουν στο
//     48ωρο → ΕΝΑ email/SMS ανά πελάτη+ημέρα, με ώρα προσέλευσης του πρώτου.
//  2. ΟΔΗΓΙΕΣ ΠΡΙΝ/ΜΕΤΑ: μελλοντικά ραντεβού → ΕΝΑ email/SMS ανά
//     πελάτη+ημέρα+σετ οδηγιών. Υπηρεσία χωρίς σετ → απλό email κλεισίματος.
//  3. ΖΗΤΗΣΗ ΑΞΙΟΛΟΓΗΣΗΣ: ΟΛΟΚΛΗΡΩΜΕΝΑ → ΕΝΑ αίτημα ανά πελάτη+ημέρα,
//     reviewDelayMinutes λεπτά μετά το ΤΕΛΟΣ του τελευταίου ραντεβού της
//     ημέρας. Τρέχει ΜΟΝΟ όταν review_request_enabled === true ΚΑΙ υπάρχει
//     review_link.
//
// Idempotency: μοναδικό (appointment_id, automation_type, cycle) με
// cycle = start_time — αλλαγή ώρας ραντεβού ξεκινάει αυτόματα νέο κύκλο.
//
// Χειροκίνητες ενέργειες (από το CRM, με login): POST body
// {action:'resend_confirmation'|'resend_instructions'|'resend_review_request'|'send_booking_confirmation', appointment_id} —
// στέλνει ξανά αγνοώντας το idempotency (καταγράφεται με channel 'manual').
//
// Deploy with:
//   supabase functions deploy appointment-automations --no-verify-jwt
// (in-code auth: x-cron-secret για το cron Ή Supabase JWT για χειροκίνητες)
// Secrets: BIRTHDAY_CRON_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//   BL_REFRESH_TOKEN, APIFON_TOKEN, APIFON_API_KEY, APIFON_SENDER_ID.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SENDER = 'yourbeautyline@gmail.com';
const CONFIRM_URL = 'https://kfidxwqgsaisbdgucsok.supabase.co/functions/v1/appointment-confirm';
const SITE_URL = 'https://medi360-crm.netlify.app';

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

async function sendEmail(token: string, to: string, subject: string, html: string, ics: string | undefined, fromName: string) {
  const head = [
    `From: ${fromName.replace(/[\r\n]/g, '')} <${SENDER}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
    `MIME-Version: 1.0`,
  ];
  let message: string;
  if (ics) {
    // multipart: HTML + συνημμένο .ics (ημερολόγιο με υπενθύμιση 1 ώρα πριν)
    const boundary = 'blcalmixed';
    message = [
      ...head,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      b64utf8(html),
      `--${boundary}`,
      `Content-Type: text/calendar; charset="UTF-8"; method=PUBLISH; name="randevou.ics"`,
      `Content-Disposition: attachment; filename="randevou.ics"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      b64utf8(ics),
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    message = [...head, `Content-Type: text/html; charset="UTF-8"`, `Content-Transfer-Encoding: base64`].join('\r\n') + '\r\n\r\n' + b64utf8(html);
  }
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

// Μορφή τηλεφώνου για SMS πάροχο: μόνο ψηφία, με κωδικό χώρας (30 για
// Ελλάδα) χωρίς το "+". Δέχεται ό,τι μορφή κι αν έχει καταχωρηθεί στην
// καρτέλα (με/χωρίς +30, κενά, παύλες).
function normalizeSmsPhone(phone: string | undefined | null): string | null {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('30') && digits.length === 12) return digits;
  if (digits.length === 10 && digits.startsWith('69')) return '30' + digits;
  if (digits.length >= 10) return digits; // ξένος αριθμός — ήδη με κωδικό χώρας
  return null;
}

// Apifon HMAC signing (βλ. docs.apifon.com/authentication.html): Authorization
// header = "ApifonWS {token}:{signature}", signature = Base64(HMAC-SHA256(
// secretKey, StringToSign)) όπου StringToSign = METHOD "\n" PATH "\n" BODY
// "\n" DATE (DATE = X-ApifonWS-Date header, ίδια μορφή με Date#toUTCString()
// — "Thu, 29 Sep 2016 12:18:56 GMT").
async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  let bin = '';
  new Uint8Array(sig).forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

const APIFON_SMS_PATH = '/services/api/v1/sms/send';

// SMS μέσω Apifon (SMS Gateway REST API — docs.apifon.com). Χρειάζεται τα
// secrets APIFON_TOKEN (API Token) και APIFON_API_KEY (το secret key του
// token — HMAC type) στο Project Settings → Edge Functions → Secrets· χωρίς
// αυτά επιστρέφει { ok:false, error:'not_configured' } χωρίς να σκάει τίποτα
// (δεν μπλοκάρει ποτέ τα email). Προαιρετικό APIFON_SENDER_ID (έως 11 λατινικά
// αλφαριθμητικά) — αλλιώς 'BeautyLine'.
async function sendSms(phone: string | undefined | null, message: string): Promise<{ ok: boolean; error?: string; providerId?: string }> {
  const to = normalizeSmsPhone(phone);
  if (!to) return { ok: false, error: 'invalid_phone' };
  const token = Deno.env.get('APIFON_TOKEN');
  const apiKey = Deno.env.get('APIFON_API_KEY');
  if (!token || !apiKey) return { ok: false, error: 'not_configured' };
  const senderId = Deno.env.get('APIFON_SENDER_ID') || 'BeautyLine';

  const body = JSON.stringify({
    subscribers: [{ number: to }],
    // dc:2 = UCS-2 encoding — απαραίτητο για ελληνικό κείμενο (πεζά + τόνοι).
    message: { text: message, sender_id: senderId, dc: 2 },
  });
  const date = new Date().toUTCString();
  const stringToSign = ['POST', APIFON_SMS_PATH, body, date].join('\n');
  const signature = await hmacSha256Base64(apiKey, stringToSign);

  try {
    const res = await fetch('https://ars.apifon.com' + APIFON_SMS_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ApifonWS-Date': date,
        Authorization: `ApifonWS ${token}:${signature}`,
      },
      body,
    });
    const out = await res.json();
    if (!res.ok || !out.result_info || out.result_info.status_code !== 200) {
      return { ok: false, error: JSON.stringify(out) };
    }
    const results = out.results && out.results[to];
    const providerId = results && results[0] && results[0].message_id;
    return { ok: true, providerId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const SHORT_CODE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// Σύντομος σύνδεσμος για SMS: αποθηκεύουμε τυχαίο 8-char κωδικό στο
// link_codes και το SMS κρατάει μόνο ?c=<code>.
async function makeShortLink(
  supabase: ReturnType<typeof createClient>,
  appointmentId: string,
  ts: number,
  kind: 'confirm' | 'ics' | 'instructions',
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = '';
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    for (const b of bytes) code += SHORT_CODE_CHARS[b % SHORT_CODE_CHARS.length];
    const { error } = await supabase.from('link_codes').insert({ code, appointment_id: appointmentId, ts, kind });
    if (!error) return `${CONFIRM_URL}?c=${code}`;
  }
  const suffix = kind === 'ics' ? '&ics=1' : kind === 'instructions' ? '&view=instructions' : '';
  return `${CONFIRM_URL}?id=${appointmentId}&ts=${ts}${suffix}`;
}

// SMS σε ΚΕΦΑΛΑΙΑ χωρίς τόνους. ΠΟΤΕ μην το εφαρμόζεις σε link
// (τα ?c= codes είναι case-sensitive).
function smsCaps(s: string): string {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

// Ίδια κανονικοποίηση με το index.html (normalizeGreek).
function normalizeGreek(s: string): string {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

// Βασικός έλεγχος μορφής email.
function isValidEmail(email: unknown): boolean {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function athensDT(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Athens' })
    + ' στις ' + d.toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Athens' });
}
function athensDateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Athens' });
}
function athensTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Athens' });
}
function athensDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });
}

// Προεπιλεγμένα κείμενα SMS — χρησιμοποιούνται όταν η κλινική δεν έχει
// ορίσει δικό της (clinics.settings.sms_templates).
const SMS_DEFAULT_TEMPLATES: Record<string, string> = {
  booking_confirmation: 'Το ραντεβού σας στο {clinic} επιβεβαιώθηκε για {date} στις {time}. Ημερολόγιο: {calendar_link}',
  confirmation_request: 'Υπενθυμίζουμε το ραντεβού σας στο {clinic} για {date} στις {time}. Επιβεβαιώστε: {confirm_link}',
  instructions: 'Οι οδηγίες πριν και μετά τη θεραπεία σας: {instructions_link}',
  review_request: 'Ευχαριστούμε για την επίσκεψή σας στο {clinic}! Αξιολογήστε μας: {review_link}',
};
const SMS_LINK_TOKEN: Record<string, string> = {
  booking_confirmation: '{calendar_link}',
  confirmation_request: '{confirm_link}',
  instructions: '{instructions_link}',
  review_request: '{review_link}',
};

interface SmsAutomationConfig { enabled?: boolean; text?: string }

function smsConfigFor(settings: Record<string, unknown> | undefined, key: string): { enabled: boolean; text: string } {
  const all = (settings && (settings.sms_templates as Record<string, SmsAutomationConfig> | undefined)) || {};
  const cfg = all[key] || {};
  return {
    enabled: cfg.enabled !== false,
    text: (cfg.text && cfg.text.trim()) || SMS_DEFAULT_TEMPLATES[key],
  };
}

// Γεμίζει το template με τις μεταβλητές (πριν το smsCaps) και μετά βάζει το
// link ΑΚΡΙΒΩΣ όπως είναι (case-sensitive ?c= κωδικός).
function fillSmsTemplate(template: string, vars: Record<string, string>, linkToken: string, linkValue: string): string {
  const MARK = 'ZZZSMSLINKZZZ';
  let t = template.includes(linkToken) ? template.split(linkToken).join(MARK) : template + ' ' + MARK;
  for (const [k, v] of Object.entries(vars)) t = t.split(k).join(v);
  t = smsCaps(t);
  return t.replace(MARK, linkValue);
}

// ── Ημερολόγιο: Google Calendar link + .ics με υπενθύμιση 1 ώρα πριν ──
function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z/, 'Z');
}
function icsEsc(s: string): string {
  return (s || '').replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n');
}
interface Brand { name: string; color: string; logoUrl: string }

function buildCalendarBits(appts: Appt[], address: string, brand: Brand) {
  const sorted = [...appts].sort((a, b) => (a.start_time < b.start_time ? -1 : 1));
  const start = new Date(sorted[0].start_time);
  const last = sorted[sorted.length - 1];
  const end = new Date(new Date(last.start_time).getTime() + ((last as { duration_minutes?: number }).duration_minutes || 60) * 60000);
  const title = 'Ραντεβού ' + brand.name;
  const services = sorted.map((a) => a.service_name).filter(Boolean).join(', ');
  const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address);
  const details = `${services}\nΟδηγίες πρόσβασης (Google Maps): ${mapsUrl}`;
  const gcal = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + '&text=' + encodeURIComponent(title)
    + '&dates=' + icsDate(start) + '/' + icsDate(end)
    + '&details=' + encodeURIComponent(details)
    + '&location=' + encodeURIComponent(address);
  const outlook = 'https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent'
    + '&subject=' + encodeURIComponent(title)
    + '&startdt=' + encodeURIComponent(start.toISOString())
    + '&enddt=' + encodeURIComponent(end.toISOString())
    + '&body=' + encodeURIComponent(details)
    + '&location=' + encodeURIComponent(address);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//' + icsEsc(brand.name) + '//medi360//EL', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' + sorted[0].id + '@beautyline',
    'DTSTAMP:' + icsDate(new Date()),
    'DTSTART:' + icsDate(start),
    'DTEND:' + icsDate(end),
    'SUMMARY:' + icsEsc(title),
    'DESCRIPTION:' + icsEsc(details),
    'LOCATION:' + icsEsc(address),
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(title + ' σε 1 ώρα'), 'TRIGGER:-PT1H', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  return { gcal, outlook, ics };
}

function calendarButtonHtml(gcal: string, outlook: string, icsUrl: string): string {
  const pill = (href: string, label: string, bg: string) =>
    `<a href="${esc(href)}" style="display:inline-block;background-color:${bg};color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;font-size:12.5px;font-weight:bold;text-decoration:none;padding:9px 16px;border-radius:22px;margin:3px 3px;">${label}</a>`;
  return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:12px 0 0;">
          <div style="font-size:12.5px;font-weight:bold;color:#333333;-webkit-text-fill-color:#333333;margin-bottom:6px;">🗓 Προσθήκη στο Ημερολόγιό μου</div>
          ${pill(gcal, 'Google', '#185FA5')}
          ${pill(outlook, 'Outlook', '#0F5E9C')}
          ${pill(icsUrl, ' iPhone / Apple', '#333333')}
        </td></tr><tr><td align="center" style="padding:6px 0 0;font-size:11px;color:#8A6070;-webkit-text-fill-color:#8A6070;">Με υπενθύμιση 1 ώρα πριν και οδηγίες Google Maps — ή ανοίξτε το συνημμένο αρχείο ημερολογίου</td></tr></table>`;
}

// ── Email templates (solid hex + -webkit-text-fill-color για iPhone dark mode) ──
function shell(inner: string, brand: Brand): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background-color:#FAF3F6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF3F6;padding:24px 0;"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#FFFFFF;border-radius:18px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
      ${inner}
      <tr><td style="padding:0 26px 22px;font-size:11.5px;color:#8A6070;-webkit-text-fill-color:#8A6070;text-align:center;">${esc(brand.name)}</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function headerBand(brand: Brand, emoji: string, title: string): string {
  const logo = brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" style="max-height:40px;margin-bottom:8px;" />` : '';
  return `
      <tr><td style="background-color:${esc(brand.color)};padding:28px 30px;text-align:center;">
        ${logo}
        <div style="font-size:36px;line-height:1;">${emoji}</div>
        <div style="font-size:21px;font-weight:bold;color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;margin-top:8px;">${title}</div>
      </td></tr>`;
}

// Δέχεται 1+ ραντεβού ΤΗΣ ΙΔΙΑΣ ΗΜΕΡΑΣ — ένα email με «ώρα προσέλευσης»
// του πρώτου και λίστα όλων.
function confirmationEmailHtml(name: string, appts: Appt[], confirmLink: string, cancelLink: string, calBtn: string, brand: Brand): string {
  const sorted = [...appts].sort((a, b) => (a.start_time < b.start_time ? -1 : 1));
  const first = sorted[0];
  const multi = sorted.length > 1;
  const dayStr = new Date(first.start_time).toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Athens' });
  const rows = sorted.map((a) => `
          <div style="font-size:14px;color:#333333;-webkit-text-fill-color:#333333;margin-top:6px;"><b>${esc(athensTime(a.start_time))}</b> — ${esc(a.service_name || '')}</div>`).join('');
  return shell(`
      ${headerBand(brand, '📅', 'Επιβεβαίωση ' + (multi ? 'Ραντεβού Ημέρας' : 'Ραντεβού'))}
      <tr><td style="padding:28px 30px;">
        <p style="font-size:15px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 16px;">Αγαπητή/έ κε/κα <b>${esc(name)}</b>,</p>
        <p style="font-size:15px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 18px;">${multi ? `Έχετε <b>${sorted.length} ραντεβού</b> την ίδια ημέρα:` : 'Έχετε προγραμματισμένο ραντεβού:'}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF0F5;border-radius:14px;"><tr><td style="padding:18px 22px;text-align:center;">
          <div style="font-size:15px;font-weight:bold;color:${esc(brand.color)};-webkit-text-fill-color:${esc(brand.color)};">${esc(dayStr)}</div>
          ${rows}
          ${multi ? `<div style="font-size:13.5px;font-weight:bold;color:#0F6E56;-webkit-text-fill-color:#0F6E56;margin-top:12px;">Ώρα προσέλευσης: ${esc(athensTime(first.start_time))}</div>` : ''}
        </td></tr></table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:22px 0 6px;">
          <a href="${esc(confirmLink)}" style="display:inline-block;background-color:#0F6E56;color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;font-size:15px;font-weight:bold;text-decoration:none;padding:14px 34px;border-radius:30px;">✅ Επιβεβαιώνω ${multi ? 'τα ραντεβού' : 'το ραντεβού'}</a>
        </td></tr></table>
        ${calBtn}
        <p style="font-size:13px;line-height:1.7;color:#8A6070;-webkit-text-fill-color:#8A6070;margin:14px 0 0;text-align:center;">Αν η ώρα δεν σας εξυπηρετεί ή θέλετε αλλαγή, απαντήστε σε αυτό το email ή τηλεφωνήστε μας.<br/>Δεν μπορείτε να έρθετε; <a href="${esc(cancelLink)}" style="color:#8A6070;text-decoration:underline;">Ακυρώστε ${multi ? 'τα ραντεβού σας' : 'το ραντεβού σας'} εδώ</a>.</p>
      </td></tr>`, brand);
}

function instructionsEmailHtml(name: string, service: string, whenStr: string, status: string, pre: string, post: string, calBtn: string, brand: Brand): string {
  const statusVerb = status === 'confirmed' ? 'έχει επιβεβαιωθεί' : 'έχει κλειστεί';
  const block = (title: string, text: string, color: string, bg: string) => {
    if (!text) return '';
    const items = text.split(/•|\r?\n/).map((s) => s.trim()).filter(Boolean);
    const rows = items.map((item) => `
              <tr>
                <td style="padding:4px 8px 4px 0;font-size:13.5px;line-height:1.6;color:${color};-webkit-text-fill-color:${color};vertical-align:top;width:14px;">•</td>
                <td style="padding:4px 0;font-size:13.5px;line-height:1.6;color:#333333;-webkit-text-fill-color:#333333;">${esc(item)}</td>
              </tr>`).join('');
    return `
        <div style="font-size:14px;font-weight:bold;color:${color};-webkit-text-fill-color:${color};margin:18px 0 8px;">${title}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${bg};border-radius:12px;"><tr><td style="padding:12px 18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td></tr></table>`;
  };
  const hasInstructions = !!(pre || post);
  const introTail = hasInstructions ? ' Για την καλύτερη προετοιμασία και φροντίδα σας:' : '';
  return shell(`
      ${headerBand(brand, hasInstructions ? '📋' : '✅', hasInstructions ? 'Οδηγίες για το ραντεβού σας' : 'Το ραντεβού σας')}
      <tr><td style="padding:28px 30px;">
        <p style="font-size:15px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 14px;">Αγαπητή/έ κε/κα <b>${esc(name)}</b>,</p>
        <p style="font-size:14.5px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 6px;">Το ραντεβού σας για <b>${esc(service)}</b> (${esc(whenStr)}) ${statusVerb}.${introTail}</p>
        ${block('🌿 Πριν από τη θεραπεία', pre, '#0F6E56', '#E1F5EE')}
        ${block('💛 Μετά τη θεραπεία', post, '#854F0B', '#FAEEDA')}
        ${calBtn}
        <p style="font-size:13px;line-height:1.7;color:#8A6070;-webkit-text-fill-color:#8A6070;margin:18px 0 0;">Για οποιαδήποτε απορία, απαντήστε σε αυτό το email ή τηλεφωνήστε μας. Σας περιμένουμε! ✨</p>
      </td></tr>`, brand);
}

function reviewRequestEmailHtml(name: string, service: string, reviewLink: string, brand: Brand): string {
  return shell(`
      ${headerBand(brand, '⭐', 'Πώς ήταν η εμπειρία σας;')}
      <tr><td style="padding:28px 30px;">
        <p style="font-size:15px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 14px;">Αγαπητή/έ κε/κα <b>${esc(name)}</b>,</p>
        <p style="font-size:14.5px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 18px;">Ελπίζουμε να μείνατε ευχαριστημένη/ος από <b>${esc(service)}</b>. Η γνώμη σας μας βοηθάει πολύ — έχετε 30 δευτερόλεπτα για μια σύντομη αξιολόγηση;</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:6px 0 6px;">
          <a href="${esc(reviewLink)}" style="display:inline-block;background-color:${esc(brand.color)};color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;font-size:15px;font-weight:bold;text-decoration:none;padding:14px 34px;border-radius:30px;">⭐ Αφήστε μια αξιολόγηση</a>
        </td></tr></table>
        <p style="font-size:13px;line-height:1.7;color:#8A6070;-webkit-text-fill-color:#8A6070;margin:18px 0 0;">Σας ευχαριστούμε που μας εμπιστευτήκατε! ✨</p>
      </td></tr>`, brand);
}

function bookingConfirmationEmailHtml(name: string, service: string, whenStr: string, calBtn: string, brand: Brand): string {
  return shell(`
      ${headerBand(brand, '✅', 'Το ραντεβού σας κλείστηκε')}
      <tr><td style="padding:28px 30px;">
        <p style="font-size:15px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 14px;">Αγαπητή/έ κε/κα <b>${esc(name)}</b>,</p>
        <p style="font-size:14.5px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0;">Το ραντεβού σας για <b>${esc(service)}</b> κλείστηκε για <b>${esc(whenStr)}</b>. Σας περιμένουμε! ✨</p>
        ${calBtn}
      </td></tr>`, brand);
}

interface Appt {
  id: string; clinic_id: string; patient_id: string; status: string;
  start_time: string; service_name?: string; duration_minutes?: number;
  patients?: { full_name?: string; email?: string; phone?: string } | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── Auth: cron secret Ή συνδεδεμένος χρήστης του CRM ──
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
        .in('status', ['sent', 'no_email', 'no_set', 'failed_final']).limit(1);
      return !!(data && data.length);
    };

    // Καταγραφή SMS σε ξεχωριστό πίνακα (sms_log). Best effort: ποτέ δεν
    // πετάει exception, ώστε μια αποτυχία SMS να μη μπλοκάρει το email flow.
    const logSms = async (a: Appt, smsType: string, phone: string, message: string, ok: boolean, error?: string) => {
      try {
        await supabase.from('sms_log').insert({
          clinic_id: a.clinic_id, patient_id: a.patient_id, appointment_id: a.id,
          sms_type: smsType, phone, message, status: ok ? 'sent' : 'failed', error: ok ? null : (error || null),
        });
      } catch { /* best effort */ }
    };

    const MAX_ATTEMPTS = 3;
    const failureCount = async (a: Appt, type: string) => {
      const { count } = await supabase.from('communication_log').select('id', { count: 'exact', head: true })
        .eq('appointment_id', a.id).eq('automation_type', type).eq('cycle', a.start_time).eq('status', 'failed');
      return count || 0;
    };
    const AUTOMATION_LABEL: Record<string, string> = {
      confirmation_request: 'αίτημα επιβεβαίωσης', instructions: 'οδηγίες πριν/μετά', review_request: 'ζήτηση αξιολόγησης',
    };
    const notifyGiveUp = async (a: Appt, type: string, attempts: number, lastError: string) => {
      const name = (a.patients && a.patients.full_name) || 'Άγνωστος πελάτης';
      const email = (a.patients && a.patients.email) || '—';
      const html = shell(`
        ${headerBand(brand, '⚠️', 'Απέτυχε αυτόματο email')}
        <tr><td style="padding:28px 30px;">
          <p style="font-size:14.5px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 10px;">Η αυτόματη αποστολή (<b>${esc(AUTOMATION_LABEL[type] || type)}</b>) στον/στην <b>${esc(name)}</b> απέτυχε ${attempts} φορές και σταμάτησε.</p>
          <p style="font-size:13.5px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 6px;">Email: ${esc(email)}</p>
          <p style="font-size:13.5px;line-height:1.7;color:#8A6070;-webkit-text-fill-color:#8A6070;margin:0;">Σφάλμα: ${esc(lastError)}</p>
          <p style="font-size:13.5px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:14px 0 0;">Παρακαλώ ελέγξτε/ενημερώστε χειροκίνητα.</p>
        </td></tr>`, brand);
      try { await sendEmail(await gmail(), SENDER, '⚠️ Απέτυχε αυτόματο email — ' + name, html, undefined, brand.name); } catch { /* best effort */ }
    };

    const { data: clinicRow } = await supabase.from('clinics').select('*').ilike('name', '%Beauty Line%').limit(1).single();
    // ΟΛΕΣ οι σαρώσεις περιορίζονται σε ΑΥΤΗ την κλινική. Χωρίς το φίλτρο, τα
    // ραντεβού κάθε άλλης κλινικής της βάσης (π.χ. της demo με εικονικά email/
    // τηλέφωνα) θα έπαιρναν μηνύματα από τον λογαριασμό της Beauty Line.
    const configuredClinicId: string = ((clinicRow as { id?: string } | null)?.id) || '00000000-0000-0000-0000-000000000000';
    const cRow = (clinicRow || {}) as { name?: string; address?: string; settings?: { address?: string; brand_name?: string; brand_color?: string; brand_logo_url?: string; review_request_enabled?: boolean; review_link?: string; review_request_delay_days?: number; review_request_delay_minutes?: number; sms_templates?: Record<string, SmsAutomationConfig> } };
    const clinicSettings = cRow.settings as Record<string, unknown> | undefined;
    const clinicAddress = cRow.address || (cRow.settings && cRow.settings.address) || 'Beauty Line by Lina Panou';
    const brand: Brand = {
      name: (cRow.settings && cRow.settings.brand_name) || cRow.name || 'Beauty Line by Lina Panou',
      color: (cRow.settings && cRow.settings.brand_color) || '#C4618A',
      logoUrl: (cRow.settings && cRow.settings.brand_logo_url) || '',
    };
    // Στα SMS χρησιμοποιούμε το σύντομο όνομα — τα emails το πλήρες.
    const brandNameShort = brand.name.split(/\s+by\s+/i)[0];
    const reviewLink = (cRow.settings && cRow.settings.review_link) || '';
    const reviewRequestEnabled = !!(cRow.settings && cRow.settings.review_request_enabled) && !!reviewLink;
    // Καθυστέρηση ζήτησης αξιολόγησης, σε ΛΕΠΤΑ από το ΤΕΛΟΣ του τελευταίου
    // ραντεβού της ημέρας. Το παλιό review_request_delay_days (ημέρες από την
    // ΕΝΑΡΞΗ) διατηρείται ως fallback για κλινικές που το έχουν ήδη ορίσει.
    const reviewDelayMinutes = (() => {
      const s = (cRow.settings || {}) as { review_request_delay_minutes?: number; review_request_delay_days?: number };
      if (typeof s.review_request_delay_minutes === 'number' && s.review_request_delay_minutes >= 0) return s.review_request_delay_minutes;
      if (typeof s.review_request_delay_days === 'number' && s.review_request_delay_days >= 0) return s.review_request_delay_days * 1440;
      return 30;
    })();

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

    // Δέχεται ΟΛΑ τα ραντεβού μιας ημέρας (dayAppts) και στέλνει ΈΝΑ email·
    // pending = όσα δεν έχουν πάρει ακόμα αίτημα στον κύκλο τους.
    const sendConfirmation = async (dayAppts: Appt[], pending: Appt[], channel = 'email') => {
      const sorted = [...dayAppts].sort((x, y) => (x.start_time < y.start_time ? -1 : 1));
      const first = sorted[0];
      const ts = Math.floor(new Date(first.start_time).getTime() / 1000);
      const link = `${CONFIRM_URL}?id=${first.id}&ts=${ts}`;
      const cancelLink = `${CONFIRM_URL}?id=${first.id}&ts=${ts}&cancel=1`;
      const icsUrl = `${CONFIRM_URL}?id=${first.id}&ts=${ts}&ics=1`;

      const smsCfg = smsConfigFor(clinicSettings, 'confirmation_request');
      if (smsCfg.enabled) {
        const smsPhone = first.patients && first.patients.phone;
        const smsLink = await makeShortLink(supabase, first.id, ts, 'confirm');
        const smsMsg = fillSmsTemplate(smsCfg.text, {
          '{name}': (first.patients && first.patients.full_name) || '',
          '{clinic}': brandNameShort,
          '{date}': athensDateOnly(first.start_time),
          '{time}': athensTime(first.start_time),
        }, SMS_LINK_TOKEN.confirmation_request, smsLink);
        const smsResult = await sendSms(smsPhone, smsMsg);
        for (const a of pending) await logSms(a, 'confirmation_request', smsPhone || '', smsMsg, smsResult.ok, smsResult.error);
      }

      const email = first.patients && first.patients.email;
      if (!isValidEmail(email)) {
        for (const a of pending) await log(a, 'confirmation_request', channel, 'no_email');
        results.no_email++; return;
      }
      const fails = await failureCount(first, 'confirmation_request');
      if (fails >= MAX_ATTEMPTS) {
        for (const a of pending) await log(a, 'confirmation_request', channel, 'failed_final', { error: `Εγκατάλειψη μετά από ${fails} αποτυχημένες προσπάθειες` });
        await notifyGiveUp(first, 'confirmation_request', fails, 'Επαναλαμβανόμενη αποτυχία αποστολής');
        results.errors++; return;
      }
      const { gcal, outlook, ics } = buildCalendarBits(sorted, clinicAddress, brand);
      const html = confirmationEmailHtml((first.patients && first.patients.full_name) || '', sorted, link, cancelLink, calendarButtonHtml(gcal, outlook, icsUrl), brand);
      try {
        const msgId = await sendEmail(await gmail(), String(email), (sorted.length > 1 ? '📅 Επιβεβαιώστε τα ραντεβού σας — ' : '📅 Επιβεβαιώστε το ραντεβού σας — ') + brand.name, html, ics, brand.name);
        for (const a of pending) await log(a, 'confirmation_request', channel, 'sent', { metadata: { gmail_id: msgId, grouped: sorted.length } });
        results.confirmations++;
      } catch (e) {
        for (const a of pending) await log(a, 'confirmation_request', channel, 'failed', { error: e instanceof Error ? e.message : String(e) });
        results.errors++;
      }
    };

    // Υπηρεσία χωρίς Instruction Set: στέλνεται ΚΑΙ ΤΟΤΕ email, απλό
    // κλεισίματος ραντεβού — ο πελάτης δεν πρέπει να μένει χωρίς ενημέρωση.
    const sendInstructions = async (a: Appt, channel = 'email', groupAppts?: Appt[]) => {
      const set = setForService(a.service_name || '');

      // Τα ραντεβού που καλύπτει ΑΥΤΟ το μήνυμα (ίδιος πελάτης, ίδια ημέρα,
      // ίδιο σετ). Η καταγραφή γίνεται σε ΟΛΑ, ώστε να μη φύγει δεύτερο
      // πανομοιότυπο στον επόμενο κύκλο.
      const logGroup = (groupAppts && groupAppts.length) ? groupAppts : [a];
      const logAll = async (status: string, extra?: Record<string, unknown>) => {
        for (const g of logGroup) await log(g, 'instructions', channel, status, extra);
      };

      const insTs = Math.floor(new Date(a.start_time).getTime() / 1000);
      const insCfg = smsConfigFor(clinicSettings, 'instructions');
      if (insCfg.enabled) {
        const insLink = await makeShortLink(supabase, a.id, insTs, 'instructions');
        const smsPhone = a.patients && a.patients.phone;
        const smsMsg = fillSmsTemplate(insCfg.text, {
          '{name}': (a.patients && a.patients.full_name) || '',
          '{clinic}': brandNameShort,
          '{date}': athensDateOnly(a.start_time),
          '{time}': athensTime(a.start_time),
        }, SMS_LINK_TOKEN.instructions, insLink);
        const smsResult = await sendSms(smsPhone, smsMsg);
        await logSms(a, 'instructions', smsPhone || '', smsMsg, smsResult.ok, smsResult.error);
      }

      const email = a.patients && a.patients.email;
      if (!isValidEmail(email)) { await logAll('no_email', set ? { metadata: { instruction_set: set.name } } : undefined); results.no_email++; return; }
      const fails = await failureCount(a, 'instructions');
      if (fails >= MAX_ATTEMPTS) {
        await logAll('failed_final', { error: `Εγκατάλειψη μετά από ${fails} αποτυχημένες προσπάθειες` });
        await notifyGiveUp(a, 'instructions', fails, 'Επαναλαμβανόμενη αποτυχία αποστολής');
        results.errors++; return;
      }
      const insIcsUrl = `${CONFIRM_URL}?id=${a.id}&ts=${insTs}&ics=1`;
      const { gcal, outlook, ics } = buildCalendarBits([a], clinicAddress, brand);
      const html = instructionsEmailHtml((a.patients && a.patients.full_name) || '', a.service_name || '', athensDT(a.start_time), a.status, (set && set.pre_instructions) || '', (set && set.post_instructions) || '', calendarButtonHtml(gcal, outlook, insIcsUrl), brand);
      const subject = set ? '📋 Οδηγίες για το ραντεβού σας — ' + brand.name : '✅ Το ραντεβού σας — ' + brand.name;
      try {
        const msgId = await sendEmail(await gmail(), String(email), subject, html, ics, brand.name);
        await logAll('sent', { metadata: { gmail_id: msgId, instruction_set: set ? set.name : null, grouped: logGroup.length } });
        results.instructions++;
      } catch (e) {
        await logAll('failed', { error: e instanceof Error ? e.message : String(e) });
        results.errors++;
      }
    };

    // ⭐ Ζήτηση αξιολόγησης: μόνο για ολοκληρωμένα ραντεβού, με τον σύνδεσμο
    // από τις Ρυθμίσεις (review_link).
    const sendReviewRequest = async (a: Appt, channel = 'email', groupAppts?: Appt[]) => {
      if (!reviewLink) { results.errors++; return; }

      // Τα ραντεβού που καλύπτει ΑΥΤΟ το μήνυμα (ίδιος πελάτης, ίδια ημέρα). Το
      // κείμενο φτιάχνεται από το ραντεβού a — το ΤΕΛΕΥΤΑΙΟ της ημέρας, δηλαδή
      // την πιο πρόσφατη εμπειρία της πελάτισσας· η καταγραφή γίνεται σε ΟΛΑ,
      // ώστε μια επίσκεψη με δύο θεραπείες να μη στείλει δύο αιτήματα.
      const logGroup = (groupAppts && groupAppts.length) ? groupAppts : [a];
      const logAll = async (status: string, extra?: Record<string, unknown>) => {
        for (const g of logGroup) await log(g, 'review_request', channel, status, extra);
      };

      const revCfg = smsConfigFor(clinicSettings, 'review_request');
      if (revCfg.enabled) {
        const smsPhone = a.patients && a.patients.phone;
        const smsMsg = fillSmsTemplate(revCfg.text, {
          '{name}': (a.patients && a.patients.full_name) || '',
          '{clinic}': brandNameShort,
          '{date}': athensDateOnly(a.start_time),
          '{time}': athensTime(a.start_time),
        }, SMS_LINK_TOKEN.review_request, reviewLink);
        const smsResult = await sendSms(smsPhone, smsMsg);
        await logSms(a, 'review_request', smsPhone || '', smsMsg, smsResult.ok, smsResult.error);
      }

      const email = a.patients && a.patients.email;
      if (!isValidEmail(email)) { await logAll('no_email'); results.no_email++; return; }
      const fails = await failureCount(a, 'review_request');
      if (fails >= MAX_ATTEMPTS) {
        await logAll('failed_final', { error: `Εγκατάλειψη μετά από ${fails} αποτυχημένες προσπάθειες` });
        await notifyGiveUp(a, 'review_request', fails, 'Επαναλαμβανόμενη αποτυχία αποστολής');
        results.errors++; return;
      }
      const html = reviewRequestEmailHtml((a.patients && a.patients.full_name) || '', a.service_name || '', reviewLink, brand);
      try {
        const msgId = await sendEmail(await gmail(), String(email), '⭐ Πώς ήταν η εμπειρία σας; — ' + brand.name, html, undefined, brand.name);
        await logAll('sent', { metadata: { gmail_id: msgId, grouped: logGroup.length } });
        results.review_requests = (results.review_requests || 0) + 1;
      } catch (e) {
        await logAll('failed', { error: e instanceof Error ? e.message : String(e) });
        results.errors++;
      }
    };

    // Στιγμή 1 — αμέσως μετά το κλείσιμο ραντεβού από το CRM.
    const sendBookingConfirmation = async (a: Appt, channel = 'email') => {
      const bookTs = Math.floor(new Date(a.start_time).getTime() / 1000);
      const bookIcsUrl = `${CONFIRM_URL}?id=${a.id}&ts=${bookTs}&ics=1`;

      const bookCfg = smsConfigFor(clinicSettings, 'booking_confirmation');
      if (bookCfg.enabled) {
        const smsPhone = a.patients && a.patients.phone;
        const smsIcsLink = await makeShortLink(supabase, a.id, bookTs, 'ics');
        const smsMsg = fillSmsTemplate(bookCfg.text, {
          '{name}': (a.patients && a.patients.full_name) || '',
          '{clinic}': brandNameShort,
          '{date}': athensDateOnly(a.start_time),
          '{time}': athensTime(a.start_time),
        }, SMS_LINK_TOKEN.booking_confirmation, smsIcsLink);
        const smsResult = await sendSms(smsPhone, smsMsg);
        await logSms(a, 'booking_confirmation', smsPhone || '', smsMsg, smsResult.ok, smsResult.error);
      }

      const email = a.patients && a.patients.email;
      if (!isValidEmail(email)) { await log(a, 'booking_confirmation', channel, 'no_email'); results.no_email++; return; }
      const { gcal, outlook } = buildCalendarBits([a], clinicAddress, brand);
      const html = bookingConfirmationEmailHtml((a.patients && a.patients.full_name) || '', a.service_name || '', athensDT(a.start_time), calendarButtonHtml(gcal, outlook, bookIcsUrl), brand);
      try {
        const msgId = await sendEmail(await gmail(), String(email), 'Το ραντεβού σας κλείστηκε — ' + brand.name, html, undefined, brand.name);
        await log(a, 'booking_confirmation', channel, 'sent', { metadata: { gmail_id: msgId } });
        results.booking_confirmations = (results.booking_confirmations || 0) + 1;
      } catch (e) {
        await log(a, 'booking_confirmation', channel, 'failed', { error: e instanceof Error ? e.message : String(e) });
        results.errors++;
      }
    };

    // ── Χειροκίνητη ενέργεια από το CRM ──
    if (body.action && body.appointment_id) {
      const { data: appt } = await supabase.from('appointments')
        .select('id,clinic_id,patient_id,status,start_time,service_name,duration_minutes,patients(full_name,email,phone)')
        .eq('id', body.appointment_id).single();
      if (!appt) return json({ error: 'Appointment not found' }, 404);
      // Οι αυτοματισμοί (Gmail, Apifon, επωνυμία) είναι ρυθμισμένοι για ΜΙΑ κλινική.
      // Ραντεβού άλλης κλινικής (π.χ. της demo) δεν πρέπει ποτέ να στείλει μήνυμα
      // από τον λογαριασμό της — ούτε καν χειροκίνητα από το CRM.
      if ((appt as { clinic_id?: string }).clinic_id !== configuredClinicId) {
        return json({ ok: false, skipped: 'automations_not_configured_for_clinic' }, 200);
      }
      const a = appt as unknown as Appt;
      if (body.action === 'resend_confirmation') await sendConfirmation([a], [a], 'manual');
      else if (body.action === 'resend_instructions') await sendInstructions(a, 'manual');
      else if (body.action === 'resend_review_request') await sendReviewRequest(a, 'manual');
      else if (body.action === 'send_booking_confirmation') await sendBookingConfirmation(a, 'manual');
      else return json({ error: 'Unknown action' }, 400);
      return json({ ok: true, results });
    }
    if (!isCron) return json({ error: 'Missing action' }, 400);

    // ── Σάρωση cron ──
    const now = new Date();
    const in48h = new Date(now.getTime() + 48 * 3600 * 1000);
    const horizon = new Date(now.getTime() + 14 * 86400 * 1000);

    // 1) ΚΛΕΙΣΜΕΝΑ μέσα στο 48ωρο → αίτημα επιβεβαίωσης — ΟΜΑΔΟΠΟΙΗΜΕΝΑ ανά
    //    πελάτη+ημέρα: 2 ραντεβού την ίδια μέρα = ΈΝΑ email με ώρα προσέλευσης
    //    του πρώτου.
    //
    //    ΠΡΟΣΟΧΗ στο παράθυρο: το 48ωρο μετριέται ανά ΡΑΝΤΕΒΟΥ. Σε ραντεβού
    //    11:00 και 12:30 της ίδιας ημέρας, το δεύτερο μπαίνει στο παράθυρο 1,5
    //    ώρα μετά το πρώτο — σε ΑΛΛΟΝ κύκλο του cron. Αν τραβούσαμε μόνο όσα
    //    χωράνε στο παράθυρο, η ομάδα της ημέρας ήταν ελλιπής, ξαναδουλευόταν
    //    στον επόμενο κύκλο και ο πελάτης έπαιρνε ΔΕΥΤΕΡΟ μήνυμα. Γι' αυτό
    //    τραβάμε 72 ώρες (48 + όλη την υπόλοιπη ημέρα) και κρατάμε ΜΟΝΟ τις
    //    ημέρες που έχουν έστω ένα ραντεβού μέσα στο πραγματικό 48ωρο.
    const fetchHorizon = new Date(in48h.getTime() + 24 * 3600 * 1000);
    const { data: bookedRows } = await supabase.from('appointments')
      .select('id,clinic_id,patient_id,status,start_time,service_name,duration_minutes,patients(full_name,email,phone)')
      .eq('clinic_id', configuredClinicId)
      .eq('status', 'booked').gte('start_time', now.toISOString()).lte('start_time', fetchHorizon.toISOString());
    const byPatientDay: Record<string, Appt[]> = {};
    const dueDays = new Set<string>();
    for (const row of (bookedRows || []) as unknown as Appt[]) {
      const k = row.patient_id + '|' + athensDay(row.start_time);
      (byPatientDay[k] = byPatientDay[k] || []).push(row);
      if (new Date(row.start_time) <= in48h) dueDays.add(k);
    }
    for (const [k, group] of Object.entries(byPatientDay)) {
      if (!dueDays.has(k)) continue; // ημέρα ακόμα εκτός 48ώρου
      const sorted = [...group].sort((x, y) => (x.start_time < y.start_time ? -1 : 1));
      // Αν το ΠΡΩΤΟ ραντεβού έχει ήδη πάρει μήνυμα, ο πελάτης γνωρίζει ήδη
      // τη σωστή ώρα προσέλευσης. Αν όμως κλείστηκε αργότερα ραντεβού
      // ΝΩΡΙΤΕΡΟ, το sorted[0] αλλάζει και φεύγει διορθωτικό μήνυμα.
      if (await alreadyDone(sorted[0], 'confirmation_request')) continue;
      const pending: Appt[] = [];
      for (const a of sorted) if (!(await alreadyDone(a, 'confirmation_request'))) pending.push(a);
      if (!pending.length) continue;
      await sendConfirmation(sorted, pending);
    }

    // 2) ΚΛΕΙΣΜΕΝΑ Ή ΕΠΙΒΕΒΑΙΩΜΕΝΑ μελλοντικά → οδηγίες.
    const { data: confRows } = await supabase.from('appointments')
      .select('id,clinic_id,patient_id,status,start_time,service_name,duration_minutes,patients(full_name,email,phone)')
      .eq('clinic_id', configuredClinicId)
      .in('status', ['booked', 'confirmed']).gte('start_time', now.toISOString()).lte('start_time', horizon.toISOString());
    //    ΟΜΑΔΟΠΟΙΗΣΗ ανά πελάτη + ημέρα + ΣΕΤ ΟΔΗΓΙΩΝ: δύο ραντεβού την ίδια
    //    ημέρα με το ίδιο σετ έστελναν δύο ΠΑΝΟΜΟΙΟΤΥΠΑ email/SMS.
    const byInstructionGroup: Record<string, Appt[]> = {};
    for (const row of (confRows || []) as unknown as Appt[]) {
      const set = setForService(row.service_name || '');
      const k = row.patient_id + '|' + athensDay(row.start_time) + '|' + (set ? set.id : 'noset');
      (byInstructionGroup[k] = byInstructionGroup[k] || []).push(row);
    }
    for (const group of Object.values(byInstructionGroup)) {
      const sorted = [...group].sort((x, y) => (x.start_time < y.start_time ? -1 : 1));
      if (await alreadyDone(sorted[0], 'instructions')) continue;
      const pending: Appt[] = [];
      for (const a of sorted) if (!(await alreadyDone(a, 'instructions'))) pending.push(a);
      if (!pending.length) continue;
      await sendInstructions(sorted[0], 'email', pending);
    }

    // 3) ΟΛΟΚΛΗΡΩΜΕΝΑ → ζήτηση αξιολόγησης, ΟΜΑΔΟΠΟΙΗΜΕΝΑ ανά πελάτη+ημέρα:
    //    μία επίσκεψη = ΕΝΑ αίτημα, ακόμα κι αν έγιναν δύο θεραπείες. Φεύγει
    //    reviewDelayMinutes λεπτά μετά το ΤΕΛΟΣ του τελευταίου ραντεβού της
    //    ημέρας (start_time + duration), όχι μετά την έναρξη — ώστε να μην
    //    φτάνει όσο η πελάτισσα είναι ακόμα στην καμπίνα.
    if (reviewRequestEnabled) {
      const reviewHorizon = new Date(now.getTime() - 30 * 86400 * 1000);
      // Τραβάμε ΟΛΑ τα ραντεβού της περιόδου (όχι μόνο τα completed): ένα
      // ραντεβού που εκκρεμεί ακόμα κρατάει την ημέρα «ανοιχτή».
      const { data: dayRows } = await supabase.from('appointments')
        .select('id,clinic_id,patient_id,status,start_time,service_name,duration_minutes,patients(full_name,email,phone)')
        .eq('clinic_id', configuredClinicId)
        .gte('start_time', reviewHorizon.toISOString()).lte('start_time', now.toISOString());
      const apptEnd = (a: Appt) => new Date(a.start_time).getTime() + ((a.duration_minutes || 60) * 60000);
      const byReviewDay: Record<string, Appt[]> = {};
      for (const row of (dayRows || []) as unknown as Appt[]) {
        const k = row.patient_id + '|' + athensDay(row.start_time);
        (byReviewDay[k] = byReviewDay[k] || []).push(row);
      }
      // Ραντεβού ξεχασμένο σε booked/confirmed που τελείωσε πριν από πολλές
      // ώρες δεν πρέπει να μπλοκάρει για πάντα την αξιολόγηση της ημέρας.
      const STALE_MS = 12 * 3600 * 1000;
      for (const group of Object.values(byReviewDay)) {
        const stillOpen = group.some((a) =>
          (a.status === 'booked' || a.status === 'confirmed' || a.status === 'in_progress') &&
          apptEnd(a) > now.getTime() - STALE_MS);
        if (stillOpen) continue;
        const done = group.filter((a) => a.status === 'completed');
        if (!done.length) continue;
        const lastEnd = Math.max(...done.map(apptEnd));
        if (now.getTime() < lastEnd + reviewDelayMinutes * 60000) continue;
        const sorted = [...done].sort((x, y) => (x.start_time < y.start_time ? -1 : 1));
        if (await alreadyDone(sorted[0], 'review_request')) continue;
        const pending: Appt[] = [];
        for (const a of sorted) if (!(await alreadyDone(a, 'review_request'))) pending.push(a);
        if (!pending.length) continue;
        // Το κείμενο αναφέρει την ΤΕΛΕΥΤΑΙΑ θεραπεία της ημέρας.
        await sendReviewRequest(sorted[sorted.length - 1], 'email', pending);
      }
    }

    return json({ ok: true, results });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});
