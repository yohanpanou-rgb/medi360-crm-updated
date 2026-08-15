// Supabase Edge Function — 📋 Βραδινό email με το πρόγραμμα της επόμενης
// εργάσιμης ημέρας στο yourbeautyline@gmail.com.
//
// «Επόμενη εργάσιμη» = η πρώτη ημέρα (από αύριο και μετά, έως +7) που έχει
// έστω ένα μη-ακυρωμένο ραντεβού. Έτσι πιάνονται σωστά και οι Δευτέρες που
// ανοίγει κατ' εξαίρεση το ινστιτούτο, και οι αργίες — χωρίς λίστα αργιών.
// Αν καμία από τις επόμενες 7 ημέρες δεν έχει ραντεβού, δεν στέλνεται email.
//
// Το layout αντιγράφει το printDaySchedule() του index.html: ομαδοποίηση ανά
// θεραπεύτρια (therapist_id → profiles, αλλιώς "Προσωπικό: X" στα notes),
// με τη σταθερή σειρά Λίνα/Χριστιάνα/Αθανασία/Νάνσυ πρώτα.
//
// Τρέχει καθημερινά από pg_cron (βλ. supabase/create_daily_schedule_email.sql)
// στις 18:00 UTC = 21:00 Ελλάδας το καλοκαίρι / 20:00 τον χειμώνα.
//
// Deploy with:
//   supabase functions deploy daily-schedule-email --no-verify-jwt
// Secrets (υπάρχουν ήδη στο project, τίποτα νέο):
//   BIRTHDAY_CRON_SECRET (κοινό secret για όλα τα cron-triggered functions)
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BL_REFRESH_TOKEN

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RECIPIENT = 'yourbeautyline@gmail.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-cron-secret',
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

// UTF-8 safe base64
function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

// ── Ίδια λογική ονομάτων προσωπικού με το index.html ──
function greekToLatinKey(s: string): string {
  const m: Record<string, string> = { 'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th', 'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't', 'υ': 'y', 'φ': 'f', 'χ': 'ch', 'ψ': 'ps', 'ω': 'o' };
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split('').map((c) => m[c] || c).join('')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function sameStaffName(a: string, b: string): boolean {
  const ka = greekToLatinKey(a), kb = greekToLatinKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  return ka.split(' ')[0] === kb.split(' ')[0];
}

interface Appt {
  start_time: string;
  status: string;
  service_name?: string;
  duration_minutes?: number;
  therapist_id?: string | null;
  notes?: string | null;
  patients?: { full_name?: string; phone?: string } | null;
}

function apptStaffName(a: Appt, staffList: { id: string; full_name: string }[]): string | null {
  if (a.therapist_id) {
    const st = staffList.find((s) => s.id === a.therapist_id);
    if (st) return st.full_name;
  }
  const notes = a.notes || '';
  const m = notes.match(/Προσωπικό:\s*([^\n·|]+)/i);
  if (m) return m[1].trim();
  const m2 = notes.match(/booking247_id:\S+\s*\|\s*([^\n·|]+)/i);
  return m2 ? m2[1].trim() : null;
}

const FIXED = ['Λίνα', 'Χριστιάνα', 'Αθανασία', 'Νάνσυ'];

// Τα start_time είναι αποθηκευμένα σε UTC (timestamptz) — το πρόγραμμα στο
// browser τα δείχνει σε ώρα Ελλάδας, οπότε και το email κάνει την ΙΔΙΑ
// μετατροπή, αλλιώς οι ώρες βγαίνουν 2-3 ώρες πίσω (χειμώνας/καλοκαίρι).
function athensDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });
}
function athensTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Athens' });
}

interface Brand { name: string; color: string; logoUrl: string }

function scheduleEmailHtml(dayLabel: string, appts: Appt[], staffList: { id: string; full_name: string }[], brand: Brand): string {
  const canon = (t: string | null) => FIXED.find((f) => sameStaffName(f, t || '')) || t || 'Μη ανατεθειμένα';
  const groups: Record<string, Appt[]> = {};
  appts.forEach((a) => { const k = canon(apptStaffName(a, staffList)); (groups[k] = groups[k] || []).push(a); });
  const order = [...FIXED.filter((f) => groups[f]), ...Object.keys(groups).filter((k) => !FIXED.includes(k))];

  const section = (k: string) => `
    <tr><td style="padding:18px 0 6px;font-size:15px;font-weight:bold;color:${esc(brand.color)};-webkit-text-fill-color:${esc(brand.color)};border-bottom:2px solid ${esc(brand.color)};">${esc(k)} (${groups[k].length})</td></tr>
    <tr><td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${groups[k].map((a) => `
        <tr>
          <td style="padding:8px 8px 8px 0;border-bottom:1px solid #F0E2E9;font-size:13px;font-weight:bold;color:#333333;-webkit-text-fill-color:#333333;white-space:nowrap;vertical-align:top;width:48px;">${esc(athensTime(a.start_time))}</td>
          <td style="padding:8px 8px;border-bottom:1px solid #F0E2E9;font-size:13px;color:#333333;-webkit-text-fill-color:#333333;vertical-align:top;">
            <b>${esc(a.patients?.full_name || '—')}</b>
            ${a.patients?.phone ? `<br/><span style="font-size:12px;color:#8A6070;-webkit-text-fill-color:#8A6070;">${esc(a.patients.phone)}</span>` : ''}
          </td>
          <td style="padding:8px 0 8px 8px;border-bottom:1px solid #F0E2E9;font-size:12.5px;color:#555555;-webkit-text-fill-color:#555555;vertical-align:top;">${esc(a.service_name || '')}<br/><span style="font-size:11.5px;color:#8A6070;-webkit-text-fill-color:#8A6070;">${a.duration_minutes || 60}&#8242;</span></td>
        </tr>`).join('')}
      </table>
    </td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background-color:#FAF3F6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF3F6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#FFFFFF;border-radius:18px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
        <tr><td style="background-color:${esc(brand.color)};padding:26px 30px;text-align:center;">
          ${brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" style="max-height:32px;margin-bottom:6px;" />` : ''}
          <div style="font-size:34px;line-height:1;">📋</div>
          <div style="font-size:20px;font-weight:bold;color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;margin-top:8px;">Ημερήσιο Πρόγραμμα</div>
          <div style="font-size:14px;color:#F7DCE8;-webkit-text-fill-color:#F7DCE8;margin-top:5px;">${esc(dayLabel)} · ${appts.length} ραντεβού</div>
        </td></tr>
        <tr><td style="padding:10px 26px 26px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${order.map(section).join('')}
          </table>
        </td></tr>
        <tr><td style="padding:0 26px 22px;font-size:11.5px;color:#8A6070;-webkit-text-fill-color:#8A6070;text-align:center;">${esc(brand.name)} · αυτόματη ενημέρωση από το Medi360</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const secret = Deno.env.get('BIRTHDAY_CRON_SECRET');
  if (secret && req.headers.get('x-cron-secret') !== secret) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: clinic, error: clinicErr } = await supabase
      .from('clinics').select('*').ilike('name', '%Beauty Line%').limit(1).single();
    if (clinicErr || !clinic) return json({ error: 'Clinic not found: ' + (clinicErr ? clinicErr.message : '') }, 500);
    const cid = clinic.id as string;
    const cRow = clinic as { name?: string; settings?: { brand_name?: string; brand_color?: string; brand_logo_url?: string } };
    const brand: Brand = {
      name: (cRow.settings && cRow.settings.brand_name) || cRow.name || 'Beauty Line by Lina Panou',
      color: (cRow.settings && cRow.settings.brand_color) || '#C4618A',
      logoUrl: (cRow.settings && cRow.settings.brand_logo_url) || '',
    };

    // Ένα ερώτημα για όλο το 8ήμερο παράθυρο· η κατανομή σε ημέρες γίνεται
    // μετά, με βάση την ημερομηνία ΩΡΑΣ ΕΛΛΑΔΑΣ του κάθε ραντεβού (τα
    // start_time είναι UTC, οπότε τα όρια της ημέρας δεν συμπίπτουν με τα UTC).
    const nowAthens = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Athens' }));
    const dstr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const winFrom = new Date(nowAthens); winFrom.setDate(winFrom.getDate() - 1);
    const winTo = new Date(nowAthens); winTo.setDate(winTo.getDate() + 9);

    const { data: allAppts, error: apptErr } = await supabase
      .from('appointments')
      .select('start_time, status, service_name, duration_minutes, therapist_id, notes, patients(full_name, phone)')
      .eq('clinic_id', cid)
      .gte('start_time', dstr(winFrom) + 'T00:00:00')
      .lt('start_time', dstr(winTo) + 'T00:00:00')
      .neq('status', 'cancelled')
      .order('start_time');
    if (apptErr) return json({ error: 'Appointments: ' + apptErr.message }, 500);
    const byDay: Record<string, Appt[]> = {};
    ((allAppts || []) as unknown as Appt[]).forEach((a) => {
      const k = athensDay(a.start_time);
      (byDay[k] = byDay[k] || []).push(a);
    });

    // Ψάξε την πρώτη ημέρα με ραντεβού, από αύριο έως +7
    for (let ahead = 1; ahead <= 7; ahead++) {
      const day = new Date(nowAthens); day.setDate(day.getDate() + ahead);
      const appts = byDay[dstr(day)];
      if (!appts || !appts.length) continue;

      const { data: staff } = await supabase
        .from('profiles').select('id, full_name')
        .eq('clinic_id', cid).in('role', ['therapist', 'clinic_admin', 'super_admin']);

      const dayNoon = new Date(dstr(day) + 'T12:00:00Z');
      const dayLabel = dayNoon.toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

      const html = scheduleEmailHtml(dayLabel, appts, staff || [], brand);
      const subject = `📋 Πρόγραμμα — ${dayLabel} · ${appts.length} ραντεβού`;

      const token = await getGmailAccessToken();
      const headerLines = [
        `From: ${brand.name.replace(/[\r\n]/g, '')} <${RECIPIENT}>`,
        `To: ${RECIPIENT}`,
        `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
        `MIME-Version: 1.0`,
        `Content-Type: text/html; charset="UTF-8"`,
        `Content-Transfer-Encoding: base64`,
      ];
      const message = headerLines.join('\r\n') + '\r\n\r\n' + b64utf8(html);
      const raw = b64utf8(message).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      });
      const out = await gmailRes.json();
      if (out.error) return json({ error: 'Gmail: ' + JSON.stringify(out.error) }, 500);

      return json({ ok: true, day: dstr(day), appointments: appts.length });
    }

    return json({ ok: true, message: 'Καμία ημέρα με ραντεβού στις επόμενες 7 — δεν στάλθηκε email' });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});
