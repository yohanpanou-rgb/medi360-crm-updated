// Supabase Edge Function — ✅ Δημόσιο endpoint επιβεβαίωσης ραντεβού.
//
// Ο πελάτης πατάει «Επιβεβαιώνω το ραντεβού» στο email (ή, αργότερα, στο
// Viber — ίδιο endpoint) → GET ?id=<appointment uuid>&ts=<epoch της ώρας
// ραντεβού>. Αν το ραντεβού είναι ΚΛΕΙΣΜΕΝΟ και το ts ταιριάζει με την
// τρέχουσα ώρα του (ο σύνδεσμος παλιού κύκλου/πριν από reschedule
// απορρίπτεται), γίνεται ΕΠΙΒΕΒΑΙΩΜΕΝΟ, καταγράφεται στο communication_log
// και επιστρέφεται όμορφη σελίδα επιβεβαίωσης. Οι οδηγίες φεύγουν από την
// ωριαία σάρωση του appointment-automations (μέσα στη 1 ώρα).
//
// Ασφάλεια: το appointment id είναι τυχαίο UUID (μη μαντέψιμο) — λειτουργεί
// ως capability link, δεν εκθέτει δεδομένα και μόνο η μετάβαση
// booked→confirmed επιτρέπεται.
//
// Deploy with:
//   supabase functions deploy appointment-confirm --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function esc(x: unknown) {
  return (x == null ? '' : String(x)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function page(title: string, emoji: string, msg: string, ok = true): Response {
  const html = `<!doctype html><html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} — Beauty Line</title></head>
<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#FAF3F6;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;">
  <div style="max-width:420px;width:100%;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 10px 40px rgba(196,97,138,.18);text-align:center;">
    <div style="background:#C4618A;padding:26px;">
      <div style="font-size:40px;line-height:1;">${emoji}</div>
      <div style="font-size:20px;font-weight:bold;color:#fff;margin-top:8px;">${esc(title)}</div>
    </div>
    <div style="padding:26px;font-size:15px;line-height:1.7;color:#333;">${msg}
      <div style="margin-top:18px;font-size:12px;color:#8A6070;">Beauty Line by Lina Panou</div>
    </div>
  </div>
</body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('id') || '';
  const ts = url.searchParams.get('ts') || '';
  const wantsIcs = url.searchParams.get('ics') === '1';
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d+$/.test(ts)) {
    return page('Μη έγκυρος σύνδεσμος', '⚠️', 'Ο σύνδεσμος δεν είναι έγκυρος. Παρακαλούμε επικοινωνήστε μαζί μας τηλεφωνικά.', false);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: appt } = await supabase.from('appointments')
    .select('id,clinic_id,patient_id,status,start_time,service_name,duration_minutes')
    .eq('id', id).single();
  if (!appt) return page('Δεν βρέθηκε', '⚠️', 'Το ραντεβού δεν βρέθηκε. Παρακαλούμε επικοινωνήστε μαζί μας τηλεφωνικά.', false);

  // ── Λήψη .ics (κουμπί «iPhone / Apple» των emails) — δεν αγγίζει status,
  // απλώς σερβίρει το αρχείο ημερολογίου με το ίδιο περιεχόμενο του
  // συνημμένου. Ομαδοποιεί με τυχόν ραντεβού της ίδιας ημέρας, όπως το email.
  if (wantsIcs) {
    const { data: clinicRow } = await supabase.from('clinics').select('*').eq('id', appt.clinic_id).single();
    const cRow = (clinicRow || {}) as { address?: string; name?: string; settings?: { address?: string } };
    const address = cRow.address || (cRow.settings && cRow.settings.address) || cRow.name || 'Beauty Line by Lina Panou';
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
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Beauty Line//medi360//EL', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:' + group[0].id + '@beautyline',
      'DTSTAMP:' + icsDate(new Date()),
      'DTSTART:' + icsDate(start),
      'DTEND:' + icsDate(end),
      'SUMMARY:' + icsEsc('Ραντεβού Beauty Line'),
      'DESCRIPTION:' + icsEsc(`${services}\nΟδηγίες πρόσβασης (Google Maps): ${mapsUrl}`),
      'LOCATION:' + icsEsc(address),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc('Ραντεβού Beauty Line σε 1 ώρα'), 'TRIGGER:-PT1H', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="randevou.ics"' } });
  }

  // Ο σύνδεσμος δένεται με τη συγκεκριμένη ώρα ραντεβού (κύκλο): αν το
  // ραντεβού μετακινήθηκε μετά την αποστολή του email, ο παλιός σύνδεσμος
  // δεν ισχύει — θα σταλεί νέο αίτημα για τη νέα ώρα.
  const curTs = Math.floor(new Date(appt.start_time).getTime() / 1000);
  if (String(curTs) !== ts) {
    return page('Ο σύνδεσμος έληξε', '🔄', 'Το ραντεβού σας έχει τροποποιηθεί. Θα λάβετε νέο email επιβεβαίωσης — ή επικοινωνήστε μαζί μας.', false);
  }

  const whenStr = athensDT(appt.start_time);
  if (appt.status === 'confirmed') {
    return page('Ήδη επιβεβαιωμένο', '✅', `Το ραντεβού σας για <b>${esc(appt.service_name || '')}</b> (${esc(whenStr)}) είναι ήδη επιβεβαιωμένο. Σας περιμένουμε! ✨`);
  }
  if (appt.status !== 'booked') {
    return page('Μη διαθέσιμο', '⚠️', 'Το ραντεβού δεν μπορεί να επιβεβαιωθεί από εδώ. Παρακαλούμε επικοινωνήστε μαζί μας τηλεφωνικά.', false);
  }

  const { error } = await supabase.from('appointments')
    .update({ status: 'confirmed' }).eq('id', id).eq('status', 'booked');
  if (error) return page('Σφάλμα', '⚠️', 'Κάτι πήγε στραβά. Παρακαλούμε δοκιμάστε ξανά ή τηλεφωνήστε μας.', false);

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

  return page('Το ραντεβού επιβεβαιώθηκε!', '🎉', `Ευχαριστούμε! Το ραντεβού σας για <b>${esc(appt.service_name || '')}</b> (${esc(whenStr)}) επιβεβαιώθηκε${extra ? ` — μαζί και ${extra === 1 ? 'το δεύτερο ραντεβού' : 'τα υπόλοιπα ' + extra + ' ραντεβού'} της ίδιας ημέρας` : ''}.<br/><br/>Θα λάβετε σύντομα email με χρήσιμες οδηγίες για τη θεραπεία σας. Σας περιμένουμε! ✨`);
});
