// Supabase Edge Function — polls the Booking247 relay Google Sheet (fed by
// google-apps-script/booking247-sync.gs, which reads Gmail every minute
// under the clinic's own Google account) and creates/updates the matching
// patient + appointment in the CRM.
//
// Deploy with:
//   supabase functions deploy sync-booking247 --no-verify-jwt
//
// Called on a schedule (every minute) via pg_cron + pg_net — see
// supabase/booking247_auto_sync.sql for the one-time setup SQL, which also
// creates the booking247_sync_state tracking table this function uses.
//
// Required secrets (set once via `supabase secrets set`):
//   CRON_SECRET  — any random string; must match the secret pg_cron sends,
//                  so this public URL can't be triggered by anyone else.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by
// the Supabase runtime — no need to set those as secrets yourself. This
// function uses the service_role key (not the caller's JWT) because it
// runs unattended with no logged-in user, and needs to read/write across
// every clinic that has Booking247 auto-sync configured.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

function normalizePhone(p: string | null | undefined): string {
  if (!p) return '';
  let digits = String(p).replace(/[^\d]/g, '');
  if (digits.startsWith('00') && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith('30') && digits.length > 10) digits = digits.slice(2);
  digits = digits.replace(/^0+/, '');
  return digits;
}

function normalizePatientName(s: string | null | undefined): string {
  // Στα κεφαλαία ελληνικά τα φωνήεντα γράφονται χωρίς τόνο — αφαιρούμε μόνο το
  // combining acute accent (U+0301) μετά από NFD decomposition, όχι τα διαλυτικά (U+0308).
  return (s || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/́/g, '')
    .normalize('NFC');
}

function mapApptStatus(s: string | null | undefined): string {
  const map: Record<string, string> = {
    'ολοκληρώθηκε': 'completed', 'επιβεβαιωμένο': 'confirmed', 'εγκεκριμένο': 'confirmed',
    'ακυρώθηκε': 'cancelled', 'εκκρεμεί': 'pending', pending: 'pending',
    confirmed: 'confirmed', completed: 'completed', cancelled: 'cancelled',
  };
  return map[(s || '').toLowerCase()] || 'confirmed';
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const headers = parseCSVLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => { row[h] = (vals[j] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

async function fetchSheetRows(sheetId: string, tab: string): Promise<Record<string, string>[]> {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Δεν ήταν δυνατή η ανάγνωση του Sheet (${resp.status})`);
  return parseCSV(await resp.text());
}

interface ParsedRow {
  name: string; phone: string; date: string; time: string; service: string;
  staff: string; duration: number; status: string; price: number | null;
}

function rowToAppointment(row: Record<string, string>): ParsedRow | null {
  const phone = normalizePhone(row['Τηλέφωνο']);
  const name = (row['Πελάτης'] || '').trim();
  const date = (row['Ημερομηνία'] || '').trim();
  if (!name || !date || !phone) return null;
  const priceRaw = (row['Τιμή'] || '').trim();
  const price = priceRaw ? parseFloat(priceRaw.replace(',', '.')) : null;
  return {
    name, phone, date, time: (row['Ώρα'] || '09:00').trim(),
    service: (row['Υπηρεσία'] || '').trim(), staff: (row['Προσωπικό'] || '').trim(),
    duration: parseInt(row['Διάρκεια (λεπτά)'], 10) || 60,
    status: (row['Κατάσταση'] || '').trim(),
    price: price === null || isNaN(price) ? null : price,
  };
}

function toStartTime(p: ParsedRow): string | null {
  const [d, m, y] = p.date.split('/');
  if (!d || !m || !y) return null;
  const [h, min] = p.time.split(':');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${(h || '09').padStart(2, '0')}:${(min || '00').padStart(2, '0')}:00+03:00`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && req.headers.get('x-cron-secret') !== cronSecret) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: clinics, error: clinicsErr } = await supabase
    .from('clinics')
    .select('id, integrations');
  if (clinicsErr) return json({ error: clinicsErr.message }, 500);

  const results: Record<string, unknown>[] = [];

  for (const clinic of clinics || []) {
    const sheetId = clinic.integrations?.booking247_sheet_id;
    if (!sheetId) continue;

    try {
      const rows = await fetchSheetRows(sheetId, 'Ραντεβού');

      const { data: state } = await supabase
        .from('booking247_sync_state')
        .select('rows_synced')
        .eq('clinic_id', clinic.id)
        .maybeSingle();
      const alreadySynced = state?.rows_synced || 0;
      const newRows = rows.slice(alreadySynced);

      let ok = 0, skip = 0, err = 0;
      for (const row of newRows) {
        const parsed = rowToAppointment(row);
        if (!parsed) { skip++; continue; }
        const startTime = toStartTime(parsed);
        if (!startTime) { skip++; continue; }

        let patientId: string | null = null;
        const { data: existingPatients } = await supabase
          .from('patients').select('id')
          .eq('clinic_id', clinic.id)
          .ilike('phone', `%${parsed.phone}%`)
          .limit(1);
        if (existingPatients && existingPatients.length) {
          patientId = existingPatients[0].id;
        } else {
          const { data: newPt, error: insPtErr } = await supabase
            .from('patients')
            .insert({ clinic_id: clinic.id, full_name: normalizePatientName(parsed.name), phone: parsed.phone, status: 'active', source: 'booking247' })
            .select('id').single();
          if (insPtErr) { err++; continue; }
          patientId = newPt?.id || null;
        }
        if (!patientId) { err++; continue; }

        const { data: existingAppt } = await supabase
          .from('appointments').select('id')
          .eq('clinic_id', clinic.id).eq('patient_id', patientId).eq('start_time', startTime)
          .limit(1);
        if (existingAppt && existingAppt.length) { skip++; continue; }

        const { error: insApptErr } = await supabase.from('appointments').insert({
          clinic_id: clinic.id, patient_id: patientId,
          service_name: parsed.service, start_time: startTime,
          duration_minutes: parsed.duration || 60, price: parsed.price,
          status: mapApptStatus(parsed.status),
          notes: parsed.staff ? `Προσωπικό: ${parsed.staff}` : '',
        });
        if (insApptErr) err++; else ok++;
      }

      await supabase.from('booking247_sync_state').upsert({
        clinic_id: clinic.id, rows_synced: rows.length, last_synced_at: new Date().toISOString(),
      });

      results.push({ clinic_id: clinic.id, new_rows: newRows.length, ok, skip, err });
    } catch (e) {
      results.push({ clinic_id: clinic.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return json({ ok: true, results });
});
