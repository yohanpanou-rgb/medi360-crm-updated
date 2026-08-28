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
//     service_instruction_map). Υπηρεσία χωρίς σετ → φεύγει ΚΑΙ ΤΟΤΕ email,
//     απλό κλεισίματος ραντεβού χωρίς τμήματα πριν/μετά (όχι σιωπή).
//  3. ΖΗΤΗΣΗ ΑΞΙΟΛΟΓΗΣΗΣ: ραντεβού ΟΛΟΚΛΗΡΩΜΕΝΑ (completed) που πέρασαν τις
//     clinics.settings.review_request_delay_days ημέρες από την ώρα τους →
//     email με σύνδεσμο αξιολόγησης (clinics.settings.review_link). Τρέχει
//     ΜΟΝΟ όταν clinics.settings.review_request_enabled === true ΚΑΙ υπάρχει
//     review_link — παραμένει ανενεργή μέχρι να ενεργοποιηθεί ρητά από τις
//     Ρυθμίσεις της κλινικής.
//
// Idempotency: μοναδικό (appointment_id, automation_type, cycle) με
// cycle = start_time — αλλαγή ώρας ραντεβού ξεκινά αυτόματα νέο κύκλο.
//
// Χειροκίνητες ενέργειες (από το CRM, με login): POST body
// {action:'resend_confirmation'|'resend_instructions'|'resend_review_request', appointment_id} —
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

// Ίδια κανονικοποίηση με το index.html (normalizeGreek): πεζά + χωρίς τόνους —
// έτσι το service_name του ραντεβού ταιριάζει με τον κατάλογο υπηρεσιών.
function normalizeGreek(s: string): string {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

function athensDT(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Athens' })
    + ' στις ' + d.toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Athens' });
}
function athensTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Athens' });
}
function athensDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });
}

// ── Ημερολόγιο: Google Calendar link + .ics με υπενθύμιση 1 ώρα πριν και
// τοποθεσία/οδηγίες Google Maps ──
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
  // Outlook.com / Office 365 deeplink (web Outlook — το desktop Outlook
  // ανοίγει το .ics)
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
// Τρία κουμπιά: Google (web link), Outlook (web deeplink), Apple/iPhone
// (σύνδεσμος .ics από το appointment-confirm — το iPhone τον ανοίγει
// κατευθείαν στο Ημερολόγιο, με την υπενθύμιση 1 ώρας μέσα).
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

// ── Email templates (ίδιο ύφος για κάθε κλινική: solid hex + -webkit-text-
// fill-color για iPhone dark mode· χρώμα/λογότυπο/όνομα έρχονται από τις
// ρυθμίσεις branding της κλινικής — clinics.settings.brand_*) ──
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

// Δέχεται 1+ ραντεβού ΤΗΣ ΙΔΙΑΣ ΗΜΕΡΑΣ — σε πολλαπλά, ένα email με «ώρα
// προσέλευσης» του πρώτου και λίστα όλων, για να μην μπερδεύεται ο πελάτης.
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
  // Οι οδηγίες φεύγουν αμέσως με το κλείσιμο, όχι μόνο μετά την επιβεβαίωση
  // (βλ. σάρωση cron πιο κάτω) — το κείμενο πρέπει να ταιριάζει με την
  // πραγματική κατάσταση, αλλιώς λέει «επιβεβαιώθηκε» σε ραντεβού που είναι
  // ακόμα μόνο Κλεισμένο.
  const statusVerb = status === 'confirmed' ? 'έχει επιβεβαιωθεί' : 'έχει κλειστεί';
  // Κάθε bullet («•» ή αλλαγή γραμμής, ανάλογα πώς το έγραψε ο διαχειριστής στο
  // Instruction Set) σε ΔΙΚΗ ΤΟΥ γραμμή, ευθυγραμμισμένη αριστερά — σε
  // white-space:pre-line παράγραφο τα bullets συνέχιζαν σαν μία πρόταση και
  // τύλιγαν άσχημα σε κινητό.
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
  // Υπηρεσία χωρίς Instruction Set (κανένα pre/post) → απλό email κλεισίματος
  // ραντεβού, χωρίς την πλαισίωση «οδηγιών» που δεν υπάρχουν.
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

interface Appt {
  id: string; clinic_id: string; patient_id: string; status: string;
  start_time: string; service_name?: string; duration_minutes?: number;
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

    // Διεύθυνση ινστιτούτου για ημερολόγιο/χάρτες — fallback στο όνομα (το
    // Google Maps βρίσκει την επιχείρηση με αναζήτηση ονόματος).
    const { data: clinicRow } = await supabase.from('clinics').select('*').ilike('name', '%Beauty Line%').limit(1).single();
    const cRow = (clinicRow || {}) as { name?: string; address?: string; settings?: { address?: string; brand_name?: string; brand_color?: string; brand_logo_url?: string; review_request_enabled?: boolean; review_link?: string; review_request_delay_days?: number } };
    const clinicAddress = cRow.address || (cRow.settings && cRow.settings.address) || 'Beauty Line by Lina Panou';
    const brand: Brand = {
      name: (cRow.settings && cRow.settings.brand_name) || cRow.name || 'Beauty Line by Lina Panou',
      color: (cRow.settings && cRow.settings.brand_color) || '#C4618A',
      logoUrl: (cRow.settings && cRow.settings.brand_logo_url) || '',
    };
    const reviewLink = (cRow.settings && cRow.settings.review_link) || '';
    const reviewRequestEnabled = !!(cRow.settings && cRow.settings.review_request_enabled) && !!reviewLink;
    const reviewRequestDelayDays = (cRow.settings && cRow.settings.review_request_delay_days) || 2;

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

    // Δέχεται ΟΛΑ τα ραντεβού μιας ημέρας του πελάτη (dayAppts) και στέλνει ΕΝΑ
    // email· pending = όσα δεν έχουν πάρει ακόμα αίτημα στον κύκλο τους (μόνο
    // αυτά καταγράφονται). Το κουμπί επιβεβαιώνει όλη την ημέρα (βλ.
    // appointment-confirm).
    const sendConfirmation = async (dayAppts: Appt[], pending: Appt[], channel = 'email') => {
      const sorted = [...dayAppts].sort((x, y) => (x.start_time < y.start_time ? -1 : 1));
      const first = sorted[0];
      const email = first.patients && first.patients.email;
      if (!email || !String(email).includes('@')) {
        for (const a of pending) await log(a, 'confirmation_request', channel, 'no_email');
        results.no_email++; return;
      }
      const ts = Math.floor(new Date(first.start_time).getTime() / 1000);
      const link = `${CONFIRM_URL}?id=${first.id}&ts=${ts}`;
      const cancelLink = `${CONFIRM_URL}?id=${first.id}&ts=${ts}&cancel=1`;
      const icsUrl = `${CONFIRM_URL}?id=${first.id}&ts=${ts}&ics=1`;
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
    // κλεισίματος ραντεβού χωρίς τμήματα πριν/μετά (βλ. instructionsEmailHtml) —
    // ο πελάτης δεν πρέπει να μένει χωρίς καμία ενημέρωση επειδή λείπει σετ.
    const sendInstructions = async (a: Appt, channel = 'email') => {
      const set = setForService(a.service_name || '');
      const email = a.patients && a.patients.email;
      if (!email || !String(email).includes('@')) { await log(a, 'instructions', channel, 'no_email', set ? { metadata: { instruction_set: set.name } } : undefined); results.no_email++; return; }
      const insTs = Math.floor(new Date(a.start_time).getTime() / 1000);
      const insIcsUrl = `${CONFIRM_URL}?id=${a.id}&ts=${insTs}&ics=1`;
      const { gcal, outlook, ics } = buildCalendarBits([a], clinicAddress, brand);
      const html = instructionsEmailHtml((a.patients && a.patients.full_name) || '', a.service_name || '', athensDT(a.start_time), a.status, (set && set.pre_instructions) || '', (set && set.post_instructions) || '', calendarButtonHtml(gcal, outlook, insIcsUrl), brand);
      const subject = set ? '📋 Οδηγίες για το ραντεβού σας — ' + brand.name : '✅ Το ραντεβού σας — ' + brand.name;
      try {
        const msgId = await sendEmail(await gmail(), String(email), subject, html, ics, brand.name);
        await log(a, 'instructions', channel, 'sent', { metadata: { gmail_id: msgId, instruction_set: set ? set.name : null } });
        results.instructions++;
      } catch (e) {
        await log(a, 'instructions', channel, 'failed', { error: e instanceof Error ? e.message : String(e) });
        results.errors++;
      }
    };

    // ⭐ Ζήτηση αξιολόγησης: μόνο για ολοκληρωμένα ραντεβού, με τον σύνδεσμο
    // από τις Ρυθμίσεις (review_link) — χωρίς σύνδεσμο δεν έχει νόημα η
    // αποστολή, ούτε καν χειροκίνητα.
    const sendReviewRequest = async (a: Appt, channel = 'email') => {
      if (!reviewLink) { results.errors++; return; }
      const email = a.patients && a.patients.email;
      if (!email || !String(email).includes('@')) { await log(a, 'review_request', channel, 'no_email'); results.no_email++; return; }
      const html = reviewRequestEmailHtml((a.patients && a.patients.full_name) || '', a.service_name || '', reviewLink, brand);
      try {
        const msgId = await sendEmail(await gmail(), String(email), '⭐ Πώς ήταν η εμπειρία σας; — ' + brand.name, html, undefined, brand.name);
        await log(a, 'review_request', channel, 'sent', { metadata: { gmail_id: msgId } });
        results.review_requests = (results.review_requests || 0) + 1;
      } catch (e) {
        await log(a, 'review_request', channel, 'failed', { error: e instanceof Error ? e.message : String(e) });
        results.errors++;
      }
    };

    // ── Χειροκίνητη ενέργεια από το CRM ──
    if (body.action && body.appointment_id) {
      const { data: appt } = await supabase.from('appointments')
        .select('id,clinic_id,patient_id,status,start_time,service_name,duration_minutes,patients(full_name,email)')
        .eq('id', body.appointment_id).single();
      if (!appt) return json({ error: 'Appointment not found' }, 404);
      const a = appt as unknown as Appt;
      if (body.action === 'resend_confirmation') await sendConfirmation([a], [a], 'manual');
      else if (body.action === 'resend_instructions') await sendInstructions(a, 'manual');
      else if (body.action === 'resend_review_request') await sendReviewRequest(a, 'manual');
      else return json({ error: 'Unknown action' }, 400);
      return json({ ok: true, results });
    }
    if (!isCron) return json({ error: 'Missing action' }, 400);

    // ── Σάρωση cron ──
    const now = new Date();
    const in48h = new Date(now.getTime() + 48 * 3600 * 1000);
    const horizon = new Date(now.getTime() + 14 * 86400 * 1000);

    // 1) ΚΛΕΙΣΜΕΝΑ μέσα στο 48ωρο → αίτημα επιβεβαίωσης — ΟΜΑΔΟΠΟΙΗΜΕΝΑ ανά
    //    πελάτη+ημέρα: 2 ραντεβού την ίδια μέρα = ΕΝΑ email με ώρα προσέλευσης
    //    του πρώτου, ώστε να μην μπερδεύεται ο πελάτης.
    const { data: bookedRows } = await supabase.from('appointments')
      .select('id,clinic_id,patient_id,status,start_time,service_name,duration_minutes,patients(full_name,email)')
      .eq('status', 'booked').gte('start_time', now.toISOString()).lte('start_time', in48h.toISOString());
    const byPatientDay: Record<string, Appt[]> = {};
    for (const row of (bookedRows || []) as unknown as Appt[]) {
      const k = row.patient_id + '|' + athensDay(row.start_time);
      (byPatientDay[k] = byPatientDay[k] || []).push(row);
    }
    for (const group of Object.values(byPatientDay)) {
      const pending: Appt[] = [];
      for (const a of group) if (!(await alreadyDone(a, 'confirmation_request'))) pending.push(a);
      if (!pending.length) continue;
      await sendConfirmation(group, pending);
    }

    // 2) ΚΛΕΙΣΜΕΝΑ Ή ΕΠΙΒΕΒΑΙΩΜΕΝΑ μελλοντικά χωρίς οδηγίες στον κύκλο τους →
    //    οδηγίες. Φεύγουν ΜΑΖΙ με το email κράτησης (δεν περιμένουν
    //    επιβεβαίωση) — κάποιες οδηγίες θέλουν μέρες προετοιμασία πριν τη
    //    θεραπεία, οπότε δεν έχει νόημα να φτάνουν 48ωρο πριν.
    const { data: confRows } = await supabase.from('appointments')
      .select('id,clinic_id,patient_id,status,start_time,service_name,duration_minutes,patients(full_name,email)')
      .in('status', ['booked', 'confirmed']).gte('start_time', now.toISOString()).lte('start_time', horizon.toISOString());
    for (const row of (confRows || []) as unknown as Appt[]) {
      if (await alreadyDone(row, 'instructions')) continue;
      await sendInstructions(row);
    }

    // 3) ΟΛΟΚΛΗΡΩΜΕΝΑ που πέρασαν τις καθορισμένες ημέρες από την ώρα τους →
    //    ζήτηση αξιολόγησης. Παραμένει ανενεργή μέχρι να ενεργοποιηθεί ρητά
    //    (review_request_enabled) και να οριστεί σύνδεσμος (review_link).
    if (reviewRequestEnabled) {
      const reviewCutoff = new Date(now.getTime() - reviewRequestDelayDays * 86400 * 1000);
      const reviewHorizon = new Date(now.getTime() - 30 * 86400 * 1000);
      const { data: doneRows } = await supabase.from('appointments')
        .select('id,clinic_id,patient_id,status,start_time,service_name,duration_minutes,patients(full_name,email)')
        .eq('status', 'completed').lte('start_time', reviewCutoff.toISOString()).gte('start_time', reviewHorizon.toISOString());
      for (const row of (doneRows || []) as unknown as Appt[]) {
        if (await alreadyDone(row, 'review_request')) continue;
        await sendReviewRequest(row);
      }
    }

    return json({ ok: true, results });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});
