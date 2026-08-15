// Supabase Edge Function — 🎂 Δώρο Γενεθλίων.
// Τρέχει καθημερινά (pg_cron, βλ. supabase/create_birthday_gifts.sql):
//  - Βρίσκει τους πελάτες που έχουν ΣΗΜΕΡΑ γενέθλια (ώρα Ελλάδας).
//  - Όσοι έχουν email + υπογεγραμμένο GDPR → εορταστικό email με το δώρο:
//    δωροεπιταγή GIFT_VALUE€ για θεραπεία προσώπου + 10% έκπτωση στα
//    καλλυντικά, με ισχύ 1 μήνα. Η αξία αποθηκεύεται ΑΝΑ δώρο (gift_value),
//    ώστε αλλαγή του ποσού να μην επηρεάζει ήδη δοσμένα δώρα. Αποστολή μέσω
//    Gmail API (ίδιος μηχανισμός με send-consultation-email, από
//    yourbeautyline@gmail.com).
//  - Όσοι ΔΕΝ έχουν email (ή GDPR) → εγγραφή channel='call': εμφανίζεται
//    ειδοποίηση στο Dashboard ώστε η γραμματεία να τους καλέσει.
// Κάθε πελάτης παίρνει ΕΝΑ δώρο ανά έτος (unique patient_id+year).
//
// Deploy with:
//   supabase functions deploy birthday-emails --no-verify-jwt
// Required secrets:
//   BIRTHDAY_CRON_SECRET (ίδια τιμή με το x-cron-secret του cron job)
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BL_REFRESH_TOKEN (υπάρχουν ήδη)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-cron-secret',
};

// Μέγιστη αξία της δωρεάν θεραπείας προσώπου για ΝΕΑ δώρα (από 06/08/2026: 60€).
// Γράφεται και στη στήλη birthday_gifts.gift_value — τα παλιότερα δώρα κρατούν
// την αξία με την οποία δόθηκαν (π.χ. 80€) και δεν επηρεάζονται.
const GIFT_VALUE = 60;

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

// Μικρό όνομα (πρώτη λέξη, Τίτλος-Case) για πιο ζεστό χαιρετισμό
function firstName(full: string): string {
  const w = (full || '').trim().split(/\s+/)[0] || '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

interface Brand { name: string; color: string; logoUrl: string }

function birthdayEmailHtml(name: string, expiresStr: string, bookingLink: string | undefined, brand: Brand): string {
  // Solid hex χρώματα + -webkit-text-fill-color: ίδιο pattern με το consultation
  // email για σωστή εμφάνιση στο iPhone Gmail dark mode. Χρώμα/λογότυπο/όνομα
  // έρχονται από τις ρυθμίσεις branding της κλινικής (clinics.settings.brand_*).
  const logo = brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" style="max-height:36px;margin-bottom:8px;" />` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background-color:#FAF3F6;">
  <div style="display:none!important;white-space:nowrap;font-size:0;line-height:0;">${'.'.repeat(200)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF3F6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#FFFFFF;border-radius:18px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
        <tr><td style="background-color:${esc(brand.color)};padding:34px 30px;text-align:center;">
          ${logo}
          <div style="font-size:44px;line-height:1;">🎂</div>
          <div style="font-size:24px;font-weight:bold;color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;margin-top:10px;">Χρόνια Πολλά, ${esc(name)}!</div>
          <div style="font-size:13px;color:#F7DCE8;-webkit-text-fill-color:#F7DCE8;margin-top:6px;letter-spacing:1px;">${esc(brand.name.toUpperCase())}</div>
        </td></tr>
        <tr><td style="padding:30px;">
          <p style="font-size:15px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:0 0 18px;">
            Σήμερα είναι η μέρα σας — και θέλουμε να τη γιορτάσουμε μαζί σας! 💛
            Όλη η ομάδα του ${esc(brand.name)} σάς εύχεται <b>χρόνια πολλά</b>, με υγεία, χαμόγελα και λάμψη.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FDF0F5;border-radius:14px;">
            <tr><td style="padding:22px 24px;text-align:center;">
              <div style="font-size:15px;font-weight:bold;color:${esc(brand.color)};-webkit-text-fill-color:${esc(brand.color)};">🎁 ΤΟ ΔΩΡΟ ΤΩΝ ΓΕΝΕΘΛΙΩΝ ΣΑΣ</div>
              <div style="font-size:26px;font-weight:bold;color:#333333;-webkit-text-fill-color:#333333;margin-top:12px;">Δωροεπιταγή ${GIFT_VALUE}€</div>
              <div style="font-size:14px;color:#8A6070;-webkit-text-fill-color:#8A6070;margin-top:4px;">για τη θεραπεία προσώπου της επιλογής σας</div>
              <div style="font-size:15px;font-weight:bold;color:#333333;-webkit-text-fill-color:#333333;margin-top:12px;">+ 10% έκπτωση στα καλλυντικά μας</div>
              <div style="font-size:12.5px;color:#8A6070;-webkit-text-fill-color:#8A6070;margin-top:14px;">Ισχύει έως <b>${esc(expiresStr)}</b> — κλείστε το ραντεβού σας εγκαίρως!</div>
            </td></tr>
          </table>
          ${bookingLink ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:22px 0 4px;">
            <a href="${esc(bookingLink)}" style="display:inline-block;background-color:${esc(brand.color)};color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;font-size:15px;font-weight:bold;text-decoration:none;padding:14px 34px;border-radius:30px;">📅 Κλείστε το ραντεβού σας online</a>
          </td></tr></table>` : ''}
          <p style="font-size:14px;line-height:1.7;color:#333333;-webkit-text-fill-color:#333333;margin:${bookingLink ? '14px' : '20px'} 0 0;text-align:${bookingLink ? 'center' : 'left'};">
            ${bookingLink ? 'Ή απαντήστε σε αυτό το email / τηλεφωνήστε μας — θα χαρούμε πολύ να σας δούμε! ✨' : 'Για να κλείσετε τη δωρεάν θεραπεία σας, απαντήστε σε αυτό το email ή τηλεφωνήστε μας — θα χαρούμε πολύ να σας δούμε! ✨'}
          </p>
          <p style="font-size:13px;color:#8A6070;-webkit-text-fill-color:#8A6070;margin:22px 0 0;">
            Με αγάπη,<br/><b>Η ομάδα του ${esc(brand.name)}</b>
          </p>
        </td></tr>
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

    // select('*') αντί για ρητές στήλες: αν το booking_link δεν υπάρχει ως
    // στήλη (ή μπει αργότερα), το function δεν πρέπει να σκάει ολόκληρο.
    const { data: clinic, error: clinicErr } = await supabase
      .from('clinics').select('*').ilike('name', '%Beauty Line%').limit(1).single();
    if (clinicErr || !clinic) return json({ error: 'Clinic not found: ' + (clinicErr ? clinicErr.message : '') }, 500);
    const cid = clinic.id as string;
    const c = clinic as { name?: string; booking_link?: string; settings?: { booking_link?: string; brand_name?: string; brand_color?: string; brand_logo_url?: string } };
    const bookingLink = c.booking_link || (c.settings && c.settings.booking_link) || '';
    const brand: Brand = {
      name: (c.settings && c.settings.brand_name) || c.name || 'Beauty Line by Lina Panou',
      color: (c.settings && c.settings.brand_color) || '#C4618A',
      logoUrl: (c.settings && c.settings.brand_logo_url) || '',
    };

    // Σημερινή ημερομηνία ΩΡΑΣ ΕΛΛΑΔΑΣ (το function τρέχει σε UTC)
    const nowAthens = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Athens' }));
    const todayMonth = nowAthens.getMonth();
    const todayDate = nowAthens.getDate();
    const year = nowAthens.getFullYear();

    const { data: patients } = await supabase
      .from('patients').select('id, full_name, email, phone, dob, status, gdpr_signed')
      .eq('clinic_id', cid).not('dob', 'is', null).neq('status', 'inactive');

    const celebrants = (patients || []).filter((p) => {
      const d = new Date(p.dob);
      return !isNaN(d.getTime()) && d.getMonth() === todayMonth && d.getDate() === todayDate;
    });
    if (!celebrants.length) return json({ ok: true, sent: 0, callNotices: 0, message: 'Κανένα γενέθλια σήμερα' });

    // Ήδη δοσμένα δώρα φέτος — ποτέ διπλό στο ίδιο άτομο την ίδια χρονιά
    const { data: existing } = await supabase
      .from('birthday_gifts').select('patient_id')
      .eq('clinic_id', cid).eq('year', year).in('patient_id', celebrants.map((p) => p.id));
    const alreadyGiven = new Set((existing || []).map((r) => r.patient_id));

    const expires = new Date(nowAthens); expires.setMonth(expires.getMonth() + 1);
    const expiresISO = expires.toISOString().slice(0, 10);
    const expiresStr = expires.toLocaleDateString('el-GR', { day: 'numeric', month: 'long', year: 'numeric' });

    let sent = 0, callNotices = 0;
    const errors: string[] = [];
    let token: string | null = null;

    for (const p of celebrants) {
      if (alreadyGiven.has(p.id)) continue;
      const canEmail = !!(p.email && String(p.email).includes('@') && p.gdpr_signed);
      const channel = canEmail ? 'email' : 'call';

      if (canEmail) {
        try {
          if (!token) token = await getGmailAccessToken();
          const subject = `🎂 Χρόνια Πολλά, ${firstName(p.full_name)}! Ένα δώρο σας περιμένει 🎁`;
          const html = birthdayEmailHtml(firstName(p.full_name), expiresStr, bookingLink, brand);
          const headerLines = [
            `From: ${brand.name.replace(/[\r\n]/g, '')} <yourbeautyline@gmail.com>`,
            `To: ${p.email}`,
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
          if (out.error) throw new Error(JSON.stringify(out.error));
          sent++;
        } catch (e) {
          // Αποτυχία αποστολής → καταγράφεται ως 'call' ώστε η γραμματεία να
          // το χειριστεί χειροκίνητα — το δώρο δεν χάνεται.
          errors.push(`${p.full_name}: ${e instanceof Error ? e.message : String(e)}`);
          await supabase.from('birthday_gifts').insert({
            clinic_id: cid, patient_id: p.id, year, channel: 'call', expires_at: expiresISO, gift_value: GIFT_VALUE,
          });
          callNotices++;
          continue;
        }
      } else {
        callNotices++;
      }

      await supabase.from('birthday_gifts').insert({
        clinic_id: cid, patient_id: p.id, year, channel, expires_at: expiresISO, gift_value: GIFT_VALUE,
      });
    }

    return json({ ok: true, sent, callNotices, errors });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});
