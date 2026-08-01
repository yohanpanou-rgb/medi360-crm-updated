// Supabase Edge Function — sends the "personalised skincare plan" email to a
// patient after an in-CRM Consultation is saved, replacing the external
// Google Form → Sheet → Apps Script pipeline that used to do this (that
// Apps Script's HTML template is ported here almost verbatim, including its
// iPhone-Gmail-dark-mode contrast fix — solid hex backgrounds instead of
// rgba, explicit -webkit-text-fill-color on every colored text node).
//
// Sends via the Gmail API (same mechanism as send-consent-email), not Resend —
// Resend requires verifying a domain you own before it will deliver to real
// recipients, which yourbeautyline@gmail.com can never satisfy (nobody can
// verify ownership of gmail.com). Sending through Gmail's own API as the
// already-authorized yourbeautyline@gmail.com account has no such
// restriction and reuses infrastructure already proven to work.
//
// Called from index.html via:
//   sb.functions.invoke('send-consultation-email', { body: { to, therapist_email, clinic_name, booking_link, website_link, instagram_link, facebook_link, maps_link, client_name, skin_line, expected_results, in_clinic, homecare, additional_notes } })
//
// Deploy with:
//   supabase functions deploy send-consultation-email
//
// Required secrets (already set — shared with send-consent-email):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BL_REFRESH_TOKEN

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

interface InClinicStep { label: string; items: string[]; }
interface ConsultationEmailInput {
  clientName?: string;
  skinLine?: string;
  expectedResults?: string[];
  inClinicSteps?: InClinicStep[];
  homecareSteps?: InClinicStep[];
  additionalNotes?: string;
  bookingLink?: string;
  websiteLink?: string;
  instagramLink?: string;
  facebookLink?: string;
  mapsLink?: string;
  senderName?: string;
}

const COLORS = {
  bgOuter: '#050811', bgContainer: '#0c1b2e', bgTop: '#101a33', bgIntro: '#1B2647',
  bgCardDark: '#1B2647', bgTeal: '#0B6E7A', bgPurple: '#6A1B7B', bgGold: '#D28B1F',
  textWhite: '#FFFFFF', textDark: '#0B0B0B', linkGold: '#FFDF8C', ctaBg: '#FFDF8C', ctaText: '#003F87',
};

function fmtList(items: string[]) {
  if (!items || !items.length) return '';
  return items.map((x) => `<div style="margin:0 0 6px 0;color:${COLORS.textWhite};-webkit-text-fill-color:${COLORS.textWhite};">• ${esc(x)}</div>`).join('');
}

function section(label: string, title: string, itemsHtml: string, bgColor: string, titleColor = COLORS.textWhite, bodyColor = COLORS.textWhite) {
  if (!itemsHtml) return '';
  return `
    <tr><td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bgColor}" style="background-color:${bgColor};border-radius:18px;">
        <tr><td style="padding:18px 18px 16px 18px;">
          <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.92;margin-bottom:8px;color:${bodyColor};-webkit-text-fill-color:${bodyColor};">${esc(label)}</div>
          <div style="font-size:18px;font-weight:800;margin:0 0 10px 0;color:${titleColor};-webkit-text-fill-color:${titleColor};">${esc(title)}</div>
          <div style="font-size:14px;line-height:1.55;color:${bodyColor};-webkit-text-fill-color:${bodyColor};">${itemsHtml}</div>
        </td></tr>
      </table>
    </td></tr>`;
}

function renderConsultationEmailHtml(d: ConsultationEmailInput) {
  const headerName = d.clientName ? `, ${esc(d.clientName)}` : '';
  const bookingLink = d.bookingLink || '#';
  const gmailExpandFix = '<div style="display:none!important;white-space:nowrap;font-size:0;line-height:0;">' + '.'.repeat(200) + '</div>';

  const inClinicSections = (d.inClinicSteps || [])
    .map((s, i) => section('In-clinic', `${i + 1}) ${s.label}`, fmtList(s.items), COLORS.bgCardDark))
    .join('');
  const homecareSections = (d.homecareSteps || [])
    .map((s) => section('Homecare', s.label, fmtList(s.items), COLORS.bgTeal))
    .join('');

  return `<!doctype html>
<html lang="el">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Skincare Plan</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.bgOuter};">
${gmailExpandFix}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.bgOuter}" style="background-color:${COLORS.bgOuter};">
<tr><td align="center" style="padding:18px 10px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.bgContainer}" style="width:100%;max-width:600px;border-radius:24px;overflow:hidden;background-color:${COLORS.bgContainer};">
<tr><td bgcolor="${COLORS.bgTop}" style="padding:22px 18px 18px 18px;background-color:${COLORS.bgTop};">
<div style="text-align:center;padding:6px 0 18px 0;">
  <div style="font-size:12px;letter-spacing:0.20em;text-transform:uppercase;color:${COLORS.textWhite};-webkit-text-fill-color:${COLORS.textWhite};opacity:0.72;">personalised plan</div>
  <div style="font-size:26px;letter-spacing:0.16em;text-transform:uppercase;color:${COLORS.linkGold};-webkit-text-fill-color:${COLORS.linkGold};font-weight:900;margin-top:10px;">${esc(d.senderName || 'Beauty Line')}</div>
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.bgIntro}" style="background-color:${COLORS.bgIntro};border-radius:18px;">
<tr><td style="padding:16px 16px 14px 16px;">
  <div style="font-size:15px;font-weight:900;margin-bottom:6px;color:${COLORS.textWhite};-webkit-text-fill-color:${COLORS.textWhite};">Αγαπητή${headerName}</div>
  <div style="line-height:1.65;font-size:14px;color:${COLORS.textWhite};-webkit-text-fill-color:${COLORS.textWhite};opacity:0.95;">Σας ευχαριστούμε για την επίσκεψή σας. Παρακάτω θα βρείτε το προσωποποιημένο σας skincare plan, όπως το διαμόρφωσε η θεραπεύτριά σας.</div>
</td></tr>
</table>
<div style="height:14px;line-height:14px;font-size:14px;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${section('Skin profile', 'Τύπος δέρματος / κύρια ανάγκη', d.skinLine ? `<div style="margin:0;color:${COLORS.textWhite};-webkit-text-fill-color:${COLORS.textWhite};">${esc(d.skinLine)}</div>` : '', COLORS.bgPurple)}
${section('Expected results', 'Τι να περιμένετε', fmtList(d.expectedResults || []), COLORS.bgGold, COLORS.textDark, COLORS.textDark)}
${inClinicSections}
${homecareSections}
${d.additionalNotes ? section('Notes', 'Σημειώσεις', `<div style="color:${COLORS.textWhite};-webkit-text-fill-color:${COLORS.textWhite};">${esc(d.additionalNotes)}</div>`, COLORS.bgCardDark) : ''}
</table>
<div style="text-align:center;padding:10px 0 6px 0;">
  <a href="${esc(bookingLink)}" style="display:inline-block;background:${COLORS.ctaBg};color:${COLORS.ctaText};-webkit-text-fill-color:${COLORS.ctaText};text-decoration:none;font-weight:900;border-radius:40px;padding:14px 26px;font-size:14px;">Κλείστε το επόμενο ραντεβού</a>
</div>
<div style="text-align:center;padding:14px 0 2px 0;font-size:11px;color:${COLORS.textWhite};-webkit-text-fill-color:${COLORS.textWhite};opacity:0.85;">
  ${esc(d.senderName || 'Beauty Line')}
  ${d.websiteLink ? ` · <a href="${esc(d.websiteLink)}" style="color:${COLORS.linkGold};-webkit-text-fill-color:${COLORS.linkGold};text-decoration:none;">Website</a>` : ''}
  ${d.instagramLink ? ` · <a href="${esc(d.instagramLink)}" style="color:${COLORS.linkGold};-webkit-text-fill-color:${COLORS.linkGold};text-decoration:none;">Instagram</a>` : ''}
  ${d.facebookLink ? ` · <a href="${esc(d.facebookLink)}" style="color:${COLORS.linkGold};-webkit-text-fill-color:${COLORS.linkGold};text-decoration:none;">Facebook</a>` : ''}
  ${d.mapsLink ? ` · <a href="${esc(d.mapsLink)}" style="color:${COLORS.linkGold};-webkit-text-fill-color:${COLORS.linkGold};text-decoration:none;">Maps</a>` : ''}
</div>
<div style="text-align:center;padding:8px 0 0 0;font-size:10px;color:${COLORS.textWhite};-webkit-text-fill-color:${COLORS.textWhite};opacity:0.65;">Αν έχετε απορίες, απαντήστε σε αυτό το email.</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
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

// UTF-8 safe base64
function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401);

    const { data: profile, error: profileErr } = await supabase
      .from('profiles').select('role, full_name').eq('id', user.id).single();
    if (profileErr || !profile) return json({ error: 'Profile not found' }, 403);
    if (!['super_admin', 'clinic_admin', 'therapist'].includes(profile.role)) {
      return json({ error: 'Δεν έχεις δικαίωμα αποστολής consultation email' }, 403);
    }

    const body = await req.json().catch(() => null);
    const to = body?.to;
    if (!to) return json({ error: 'Λείπει το email παραλήπτη (to)' }, 400);

    const html = renderConsultationEmailHtml({
      clientName: body.client_name,
      skinLine: body.skin_line,
      expectedResults: body.expected_results || [],
      inClinicSteps: body.in_clinic_steps || [],
      homecareSteps: body.homecare_steps || [],
      additionalNotes: body.additional_notes,
      bookingLink: body.booking_link,
      websiteLink: body.website_link,
      instagramLink: body.instagram_link,
      facebookLink: body.facebook_link,
      mapsLink: body.maps_link,
      senderName: body.clinic_name,
    });

    const token = await getGmailAccessToken();
    const senderName = String(body.clinic_name || 'Beauty Line').replace(/[\r\n]/g, '');
    const subject = `Your personalised skincare plan — ${body.clinic_name || 'Beauty Line'}`;

    const parts = [
      `From: ${senderName} <yourbeautyline@gmail.com>`,
      `To: ${to}`,
      body.therapist_email ? `Bcc: ${body.therapist_email}` : '',
      `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      b64utf8(html),
    ].filter((line) => line !== '');

    const raw = b64utf8(parts.join('\r\n'))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    const out = await gmailRes.json();
    if (out.error) return json({ error: `Αποτυχία αποστολής email: ${JSON.stringify(out.error)}` }, 502);

    return json({ ok: true, id: out.id });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});
