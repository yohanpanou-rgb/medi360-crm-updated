// Supabase Edge Function — 📢 Μαζική αποστολή (καμπάνιες μάρκετινγκ / ευχές
// γιορτών) σε φιλτραρισμένη λίστα πελατών με marketing_opt_in = true.
//
// Οι πραγματικοί αυτοματισμοί (Gmail, Apifon) είναι ρυθμισμένοι για ΜΙΑ
// κλινική (Beauty Line) — ίδιος κανόνας με το appointment-automations. Για
// ραντεβού/πελάτες άλλης κλινικής (π.χ. demo) η καμπάνια ΔΕΝ στέλνει τίποτα
// πραγματικά· γράφεται με status 'preview' και επιστρέφεται ένα δείγμα
// email/SMS ώστε το προσωπικό να δει πώς θα έμοιαζε.
//
// Called from the CRM (με login): POST body
// { campaign_id, clinic_id, channel:'email'|'sms', subject?, body, patient_ids: string[] }
//
// Deploy with:
//   supabase functions deploy bulk-messaging --no-verify-jwt
// (in-code auth: Supabase JWT + role check)
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BL_REFRESH_TOKEN,
//   APIFON_TOKEN, APIFON_API_KEY, APIFON_SENDER_ID (ίδια με appointment-automations).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SENDER = 'yourbeautyline@gmail.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

function isValidEmail(email: unknown): boolean {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
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

async function sendEmail(token: string, to: string, subject: string, html: string, fromName: string) {
  const head = [
    `From: ${fromName.replace(/[\r\n]/g, '')} <${SENDER}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
  ];
  const message = head.join('\r\n') + '\r\n\r\n' + b64utf8(html);
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
  if (digits.length >= 10) return digits;
  return null;
}

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  let bin = '';
  new Uint8Array(sig).forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

const APIFON_SMS_PATH = '/services/api/v1/sms/send';

async function sendSms(phone: string | undefined | null, message: string): Promise<{ ok: boolean; error?: string }> {
  const to = normalizeSmsPhone(phone);
  if (!to) return { ok: false, error: 'invalid_phone' };
  const token = Deno.env.get('APIFON_TOKEN');
  const apiKey = Deno.env.get('APIFON_API_KEY');
  if (!token || !apiKey) return { ok: false, error: 'not_configured' };
  const senderId = Deno.env.get('APIFON_SENDER_ID') || 'BeautyLine';

  const body = JSON.stringify({
    subscribers: [{ number: to }],
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
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Ίδιο normalize με sms templates στο appointment-automations: ΚΕΦΑΛΑΙΑ
// χωρίς τόνους (φτηνότερο SMS segment κόστος, χωρίς αλλοίωση περιεχομένου).
function smsCaps(s: string): string {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  let t = template || '';
  for (const [k, v] of Object.entries(vars)) t = t.split(k).join(v);
  return t;
}

interface Brand { name: string; color: string; logoUrl: string }

function emailShell(bodyText: string, subject: string, brand: Brand): string {
  const logo = brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" style="max-height:40px;margin-bottom:8px;" />` : '';
  const bodyHtml = esc(bodyText).replace(/\n/g, '<br>');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background-color:#FAF3F6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF3F6;padding:24px 0;"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#FFFFFF;border-radius:18px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
      <tr><td style="background-color:${esc(brand.color)};padding:26px 28px;text-align:center;">
        ${logo}
        <div style="font-size:19px;font-weight:bold;color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;">${esc(subject)}</div>
      </td></tr>
      <tr><td style="padding:26px 28px;font-size:14.5px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;">${bodyHtml}</td></tr>
      <tr><td style="padding:0 26px 22px;font-size:11.5px;color:#8A6070;-webkit-text-fill-color:#8A6070;text-align:center;">${esc(brand.name)}</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

interface Patient { id: string; full_name?: string; email?: string; phone?: string }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── Auth: μόνο συνδεδεμένοι διαχειριστές κλινικής/υπερδιαχειριστές ──
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const { data: profile } = await supabase.from('profiles').select('role,clinic_id').eq('id', user.id).single();
  if (!profile || !['super_admin', 'clinic_admin'].includes(profile.role)) {
    return json({ error: 'Forbidden' }, 403);
  }

  let body: { campaign_id?: string; clinic_id?: string; channel?: string; subject?: string; body?: string; patient_ids?: string[] } = {};
  try { body = await req.json(); } catch { /* invalid body */ }
  const { campaign_id, clinic_id, channel, subject, patient_ids } = body;
  const template = body.body || '';
  if (!campaign_id || !clinic_id || !channel || !template || !Array.isArray(patient_ids) || !patient_ids.length) {
    return json({ error: 'Missing required fields' }, 400);
  }
  if (profile.role !== 'super_admin' && profile.clinic_id !== clinic_id) {
    return json({ error: 'Forbidden' }, 403);
  }

  try {
    // Η καμπάνια πρέπει να υπάρχει ήδη σαν 'draft' (τη δημιουργεί το CRM πριν
    // καλέσει αυτό το endpoint) — ώστε να υπάρχει πάντα ένα audit trail ακόμα
    // κι αν η αποστολή αποτύχει στη μέση.
    const { data: campaign } = await supabase.from('marketing_campaigns').select('*').eq('id', campaign_id).eq('clinic_id', clinic_id).single();
    if (!campaign) return json({ error: 'Campaign not found' }, 404);

    const { data: clinicRow } = await supabase.from('clinics').select('*').ilike('name', '%Beauty Line%').limit(1).single();
    const configuredClinicId: string = ((clinicRow as { id?: string } | null)?.id) || '00000000-0000-0000-0000-000000000000';
    const isRealSend = clinic_id === configuredClinicId;

    const { data: targetClinicRow } = await supabase.from('clinics').select('name,settings').eq('id', clinic_id).single();
    const settings = ((targetClinicRow as { settings?: Record<string, any> } | null)?.settings) || {};
    const brand: Brand = {
      name: settings.brand_name || (targetClinicRow as { name?: string } | null)?.name || '',
      color: settings.brand_color || '#C4618A',
      logoUrl: settings.brand_logo_url || '',
    };

    // Ξαναφιλτράρουμε ΑΜΥΝΤΙΚΑ εδώ (clinic_id + marketing_opt_in) — ό,τι λίστα
    // κι αν έστειλε το CRM, ποτέ δεν στέλνουμε σε πελάτη χωρίς συναίνεση.
    const { data: patientsRaw } = await supabase.from('patients')
      .select('id,full_name,email,phone,marketing_opt_in,clinic_id')
      .in('id', patient_ids);
    const patients = ((patientsRaw || []) as (Patient & { marketing_opt_in?: boolean; clinic_id?: string })[])
      .filter((p) => p.clinic_id === clinic_id && p.marketing_opt_in === true);

    await supabase.from('marketing_campaigns').update({ status: 'sending' }).eq('id', campaign_id);

    const token: { v: string | null } = { v: null };
    const gmail = async () => { if (!token.v) token.v = await getGmailAccessToken(); return token.v; };

    const results: { patient_id: string; status: string; error?: string }[] = [];
    let sample: { subject?: string; html?: string; text?: string } | null = null;
    let sentCount = 0;
    let failedCount = 0;

    for (const p of patients) {
      const vars = { '{name}': p.full_name || '', '{clinic}': brand.name };
      if (channel === 'email') {
        const html = emailShell(fillTemplate(template, vars), subject || brand.name, brand);
        if (!sample) sample = { subject: subject || brand.name, html };
        if (!isRealSend) { results.push({ patient_id: p.id, status: 'preview' }); continue; }
        if (!isValidEmail(p.email)) { results.push({ patient_id: p.id, status: 'failed', error: 'no_email' }); failedCount++; continue; }
        try {
          await sendEmail(await gmail(), String(p.email), subject || brand.name, html, brand.name);
          results.push({ patient_id: p.id, status: 'sent' });
          sentCount++;
        } catch (e) {
          results.push({ patient_id: p.id, status: 'failed', error: e instanceof Error ? e.message : String(e) });
          failedCount++;
        }
      } else {
        const text = smsCaps(fillTemplate(template, vars));
        if (!sample) sample = { text };
        if (!isRealSend) { results.push({ patient_id: p.id, status: 'preview' }); continue; }
        const smsResult = await sendSms(p.phone, text);
        if (smsResult.ok) { results.push({ patient_id: p.id, status: 'sent' }); sentCount++; }
        else { results.push({ patient_id: p.id, status: 'failed', error: smsResult.error }); failedCount++; }
      }
    }

    await supabase.from('marketing_campaigns').update({
      status: isRealSend ? 'sent' : 'preview',
      recipient_count: patients.length,
      sent_count: sentCount,
      failed_count: failedCount,
      results,
      sent_at: new Date().toISOString(),
    }).eq('id', campaign_id);

    return json({ ok: true, isRealSend, recipient_count: patients.length, sent_count: sentCount, failed_count: failedCount, sample });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});
