// Supabase Edge Function — ✅ Δημόσιο endpoint επιβεβαίωσης/ακύρωσης ραντεβού.
//
// Ο πελάτης πατάει «Επιβεβαιώνω το ραντεβού» στο email (ή, αργότερα, στο
// Viber — ίδιο endpoint) → GET ?id=<appointment uuid>&ts=<epoch της ώρας
// ραντεβού>. Αν το ραντεβού είναι ΚΛΕΙΣΜΕΝΟ και το ts ταιριάζει με την
// τρέχουσα ώρα του (ο σύνδεσμος παλιού κύκλου/πριν από reschedule
// απορρίπτεται), γίνεται ΕΠΙΒΕΒΑΙΩΜΕΝΟ, καταγράφεται στο communication_log
// και ο browser γίνεται redirect σε στατική σελίδα επιβεβαίωσης στο ίδιο
// το Netlify site (/confirm.html) — βλ. σημείωση παρακάτω για το γιατί.
// Οι οδηγίες φεύγουν αμέσως με το κλείσιμο του ραντεβού, από την ωριαία
// σάρωση του appointment-automations — δεν περιμένουν επιβεβαίωση.
//
// Ακύρωση («Ακυρώστε το ραντεβού σας εδώ» στο email 48ώρου): GET με
// &cancel=1 ΔΕΝ αλλάζει τίποτα — μόνο redirect σε σελίδα «είστε σίγουρος/η;»
// (2 βήματα σκόπιμα, ώστε ένα email security scanner που «ανοίγει» αυτόματα
// τα links του email να μην ακυρώνει ραντεβού από μόνο του). Η πραγματική
// ακύρωση γίνεται με POST {id,ts} από το κουμπί της σελίδας εκείνης.
//
// Ασφάλεια: το appointment id είναι τυχαίο UUID (μη μαντέψιμο) — λειτουργεί
// ως capability link, δεν εκθέτει δεδομένα και μόνο οι μεταβάσεις
// booked/confirmed→confirmed/cancelled επιτρέπονται.
//
// Σημείωση για το redirect αντί για απευθείας HTML: το Supabase Edge
// Functions gateway επιβάλλει Content-Type: text/plain + αυστηρό
// Content-Security-Policy σε HTML απαντήσεις από *.supabase.co/functions/
// (πιθανώς σκόπιμο μέτρο ασφαλείας κατά του phishing hosting) — ό,τι
// header κι αν θέσουμε ρητά στον κώδικά μας δεν περνάει στον browser, με
// αποτέλεσμα η σελίδα να εμφανίζεται ως ακατέργαστο/λάθος-κωδικοποιημένο
// κείμενο. Το site μας (Netlify) δεν έχει αυτόν τον περιορισμό, οπότε η
// function κάνει μόνο τη δουλειά στη βάση και το frontend μας ζωγραφίζει
// την όμορφη σελίδα.
//
// Deploy with:
//   supabase functions deploy appointment-confirm --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SITE_URL = 'https://medi360-crm.netlify.app';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': SITE_URL,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

interface Brand { name: string; color: string; logoUrl: string }
const DEFAULT_BRAND: Brand = { name: 'Beauty Line by Lina Panou', color: '#C4618A', logoUrl: '' };

function redirectPage(status: string, brand: Brand, extra: Record<string, string> = {}): Response {
  const u = new URL(SITE_URL + '/confirm.html');
  u.searchParams.set('status', status);
  u.searchParams.set('brand', brand.name);
  u.searchParams.set('color', brand.color);
  if (brand.logoUrl) u.searchParams.set('logo', brand.logoUrl);
  for (const [k, v] of Object.entries(extra)) if (v) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.toString() } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

function athensDT(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Athens' })
    + ' στις ' + d.toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Athens' });
}
function athensDayKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });
}
function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z/, 'Z');
}
function icsEsc(s: string): string {
  return (s || '').replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n');
}

async function loadBrand(supabase: ReturnType<typeof createClient>, clinicId: string): Promise<{ brand: Brand; address: string }> {
  const { data: clinicRow } = await supabase.from('clinics').select('*').eq('id', clinicId).single();
  const cRow = (clinicRow || {}) as { address?: string; name?: string; settings?: { address?: string; brand_name?: string; brand_color?: string; brand_logo_url?: string } };
  const address = cRow.address || (cRow.settings && cRow.settings.address) || cRow.name || DEFAULT_BRAND.name;
  const brand: Brand = {
    name: (cRow.settings && cRow.settings.brand_name) || cRow.name || DEFAULT_BRAND.name,
    color: (cRow.settings && cRow.settings.brand_color) || DEFAULT_BRAND.color,
    logoUrl: (cRow.settings && cRow.settings.brand_logo_url) || '',
  };
  return { brand, address };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── POST: δεύτερο, ρητό βήμα της ακύρωσης (καλείται από το κουμπί «Ναι,
  // ακύρωσε» της σελίδας «είστε σίγουρος/η;» — ΟΧΙ απευθείας από το email). ──
  if (req.method === 'POST') {
    let body: { id?: string; ts?: string } = {};
    try { body = await req.json(); } catch { /* invalid body */ }
    const id = body.id || '';
    const ts = body.ts || '';
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d+$/.test(String(ts))) {
      return jsonResponse({ ok: false, error: 'invalid' }, 400);
    }
    const { data: appt } = await supabase.from('appointments')
      .select('id,clinic_id,patient_id,status,start_time,service_name,duration_minutes')
      .eq('id', id).single();
    if (!appt) return jsonResponse({ ok: false, error: 'notfound' }, 404);
    const curTs = Math.floor(new Date(appt.start_time).getTime() / 1000);
    if (String(curTs) !== String(ts)) return jsonResponse({ ok: false, error: 'stale' }, 409);
    if (appt.status === 'cancelled') return jsonResponse({ ok: false, error: 'already_cancelled' }, 409);
    if (appt.status !== 'booked' && appt.status !== 'confirmed') return jsonResponse({ ok: false, error: 'unavailable' }, 409);

    const { error } = await supabase.from('appointments')
      .update({ status: 'cancelled' }).eq('id', id).in('status', ['booked', 'confirmed']);
    if (error) return jsonResponse({ ok: false, error: 'error' }, 500);

    await supabase.from('communication_log').insert({
      clinic_id: appt.clinic_id, appointment_id: appt.id, patient_id: appt.patient_id,
      automation_type: 'cancellation_received', channel: 'email', cycle: appt.start_time,
      status: 'received', metadata: { previous_status: appt.status },
    });

    // Ίδια λογική με την επιβεβαίωση: ένα «δεν μπορώ να έρθω» ακυρώνει ΟΛΗ
    // την ημέρα, αφού το email ήταν ένα κοινό για όλα τα ραντεβού της.
    const athensDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });
    const dayKey = athensDay(appt.start_time);
    let extra = 0;
    const { data: siblings } = await supabase.from('appointments')
      .select('id,clinic_id,patient_id,start_time,status')
      .eq('patient_id', appt.patient_id).in('status', ['booked', 'confirmed']);
    for (const s of (siblings || [])) {
      if (s.id === appt.id || athensDay(s.start_time) !== dayKey) continue;
      const { error: e2 } = await supabase.from('appointments')
        .update({ status: 'cancelled' }).eq('id', s.id).in('status', ['booked', 'confirmed']);
      if (!e2) {
        extra++;
        await supabase.from('communication_log').insert({
          clinic_id: s.clinic_id, appointment_id: s.id, patient_id: s.patient_id,
          automation_type: 'cancellation_received', channel: 'email', cycle: s.start_time,
          status: 'received', metadata: { grouped_with: appt.id },
        });
      }
    }

    return jsonResponse({ ok: true, service: appt.service_name || '', when: athensDT(appt.start_time), extra });
  }

  // ── GET ──
  const url = new URL(req.url);
  const id = url.searchParams.get('id') || '';
  const ts = url.searchParams.get('ts') || '';
  const wantsIcs = url.searchParams.get('ics') === '1';
  const wantsCancel = url.searchParams.get('cancel') === '1';
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d+$/.test(ts)) {
    return redirectPage('invalid', DEFAULT_BRAND);
  }

  const { data: appt } = await supabase.from('appointments')
    .select('id,clinic_id,patient_id,status,start_time,service_name,duration_minutes')
    .eq('id', id).single();
  if (!appt) return redirectPage('notfound', DEFAULT_BRAND);

  const { brand, address } = await loadBrand(supabase, appt.clinic_id);

  // ── Λήψη .ics (κουμπί «iPhone / Apple» των emails) — δεν αγγίζει status,
  // απλώς σερβίρει το αρχείο ημερολογίου με το ίδιο περιεχόμενο του
  // συνημμένου. Ομαδοποιεί με τυχόν ραντεβού της ίδιας ημέρας, όπως το email.
  // Content-Disposition: attachment αναγκάζει λήψη αρχείου ανεξαρτήτως
  // Content-Type, οπότε δεν επηρεάζεται από τον παραπάνω περιορισμό.
  if (wantsIcs) {
    const dayKey = athensDayKey(appt.start_time);
    const { data: siblingRows } = await supabase.from('appointments')
      .select('id,start_time,service_name,duration_minutes')
      .eq('patient_id', appt.patient_id).in('status', ['booked', 'confirmed']);
    const group = [appt, ...((siblingRows || []).filter((s) => s.id !== appt.id && athensDayKey(s.start_time) === dayKey))]
      .sort((a, b) => (a.start_time < b.start_time ? -1 : 1));
    const start = new Date(group[0].start_time);
    const last = group[group.length - 1];
    const end = new Date(new Date(last.start_time).getTime() + (last.duration_minutes || 60) * 60000);
    const services = group.map((a) => a.service_name).filter(Boolean).join(', ');
    const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address);
    const title = 'Ραντεβού ' + brand.name;
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//' + icsEsc(brand.name) + '//medi360//EL', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:' + group[0].id + '@beautyline',
      'DTSTAMP:' + icsDate(new Date()),
      'DTSTART:' + icsDate(start),
      'DTEND:' + icsDate(end),
      'SUMMARY:' + icsEsc(title),
      'DESCRIPTION:' + icsEsc(`${services}\nΟδηγίες πρόσβασης (Google Maps): ${mapsUrl}`),
      'LOCATION:' + icsEsc(address),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(title + ' σε 1 ώρα'), 'TRIGGER:-PT1H', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const icsHeaders = new Headers();
    icsHeaders.set('Content-Type', 'text/calendar; charset=utf-8');
    icsHeaders.set('Content-Disposition', 'attachment; filename="randevou.ics"');
    return new Response(new TextEncoder().encode(ics), { headers: icsHeaders });
  }

  // Ο σύνδεσμος δένεται με τη συγκεκριμένη ώρα ραντεβού (κύκλο): αν το
  // ραντεβού μετακινήθηκε μετά την αποστολή του email, ο παλιός σύνδεσμος
  // δεν ισχύει — θα σταλεί νέο αίτημα για τη νέα ώρα.
  const curTs = Math.floor(new Date(appt.start_time).getTime() / 1000);
  if (String(curTs) !== ts) {
    return redirectPage('stale', brand);
  }

  const whenStr = athensDT(appt.start_time);

  // ── Ακύρωση: το GET (κλικ μέσα από το email) ΔΕΝ αλλάζει τίποτα — μόνο
  // redirect σε ενδιάμεση σελίδα «είστε σίγουρος/η;». Η πραγματική ακύρωση
  // γίνεται με το POST πιο πάνω, όταν ο πελάτης πατήσει ρητά το κουμπί εκεί. ──
  if (wantsCancel) {
    if (appt.status === 'cancelled') return redirectPage('already_cancelled', brand, { service: appt.service_name || '', when: whenStr });
    if (appt.status !== 'booked' && appt.status !== 'confirmed') return redirectPage('unavailable', brand);
    const athensDayC = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });
    const dayKeyC = athensDayC(appt.start_time);
    const { data: siblingsC } = await supabase.from('appointments')
      .select('id,start_time').eq('patient_id', appt.patient_id).in('status', ['booked', 'confirmed']);
    const siblingCount = (siblingsC || []).filter((s) => s.id !== appt.id && athensDayC(s.start_time) === dayKeyC).length;
    return redirectPage('cancel_confirm', brand, { id, ts, service: appt.service_name || '', when: whenStr, extra: String(siblingCount) });
  }

  if (appt.status === 'confirmed') {
    return redirectPage('already', brand, { service: appt.service_name || '', when: whenStr });
  }
  if (appt.status !== 'booked') {
    return redirectPage('unavailable', brand);
  }

  const { error } = await supabase.from('appointments')
    .update({ status: 'confirmed' }).eq('id', id).eq('status', 'booked');
  if (error) return redirectPage('error', brand);

  await supabase.from('communication_log').insert({
    clinic_id: appt.clinic_id, appointment_id: appt.id, patient_id: appt.patient_id,
    automation_type: 'confirmation_received', channel: 'email', cycle: appt.start_time,
    status: 'received', metadata: { previous_status: 'booked', new_status: 'confirmed' },
  });

  // Ένα κλικ επιβεβαιώνει ΟΛΗ την ημέρα: αν ο πελάτης έχει και άλλα ΚΛΕΙΣΜΕΝΑ
  // ραντεβού την ίδια ημέρα (ώρα Ελλάδας), επιβεβαιώνονται μαζί — το email
  // επιβεβαίωσης ήταν ένα, κοινό για όλα.
  const athensDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });
  const dayKey = athensDay(appt.start_time);
  let extra = 0;
  const { data: siblings } = await supabase.from('appointments')
    .select('id,clinic_id,patient_id,start_time,status')
    .eq('patient_id', appt.patient_id).eq('status', 'booked');
  for (const s of (siblings || [])) {
    if (s.id === appt.id || athensDay(s.start_time) !== dayKey) continue;
    const { error: e2 } = await supabase.from('appointments')
      .update({ status: 'confirmed' }).eq('id', s.id).eq('status', 'booked');
    if (!e2) {
      extra++;
      await supabase.from('communication_log').insert({
        clinic_id: s.clinic_id, appointment_id: s.id, patient_id: s.patient_id,
        automation_type: 'confirmation_received', channel: 'email', cycle: s.start_time,
        status: 'received', metadata: { grouped_with: appt.id },
      });
    }
  }

  return redirectPage('ok', brand, { service: appt.service_name || '', when: whenStr, extra: String(extra) });
});
