// Supabase Edge Function — scaffold for the FUTURE direct Booking247 API
// integration (as opposed to supabase/functions/sync-booking247, which reads
// the Gmail-relay Google Sheet and is already live).
//
// Today Booking247 has not given us real API credentials/docs, so this
// function cannot make the real call yet. It exists so that once we have
// the API endpoint + auth details, wiring it in is a small, contained change
// here (see the TODO block below) instead of a new integration built from
// scratch under time pressure.
//
// Deploy with:
//   supabase functions deploy booking247-api-sync
// (No --no-verify-jwt: this is called from the logged-in clinic admin's
// browser session via supabase.functions.invoke(), so the normal user JWT
// check should stay on.)
//
// Called today from index.html's Settings → Ενσωματώσεις → Booking247 →
// "Δοκιμή σύνδεσης" button (mode: 'test'), which just confirms the API key
// is saved and reports that real sync is pending the Booking247 API details.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by
// the Supabase runtime.

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

function normalizePhone(p: string | null | undefined): string {
  if (!p) return '';
  let digits = String(p).replace(/[^\d]/g, '');
  if (digits.startsWith('00') && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith('30') && digits.length > 10) digits = digits.slice(2);
  digits = digits.replace(/^0+/, '');
  return digits;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  let body: { clinic_id?: string; mode?: string } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const { clinic_id, mode } = body;
  if (!clinic_id) return json({ error: 'Λείπει clinic_id' }, 400);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: clinic, error: clinicErr } = await supabase
    .from('clinics').select('id, integrations').eq('id', clinic_id).single();
  if (clinicErr) return json({ error: clinicErr.message }, 500);

  const key = clinic?.integrations?.booking247_key;
  const company = clinic?.integrations?.booking247_company;
  const apiBaseUrl = Deno.env.get('BOOKING247_API_BASE_URL'); // set this once Booking247 gives us the real endpoint

  if (!key) {
    return json({ ready: false, message: 'Δεν έχει αποθηκευτεί ακόμα API Key.' });
  }
  if (!apiBaseUrl) {
    return json({
      ready: false,
      message: 'Κλειδί αποθηκευμένο ✓ — περιμένει τα στοιχεία σύνδεσης του πραγματικού Booking247 API (endpoint) για να ενεργοποιηθεί το sync.',
    });
  }

  if (mode === 'test') {
    // TODO once we have real Booking247 API docs: replace this with an actual
    // lightweight auth-check call (e.g. GET {apiBaseUrl}/me or /ping) using
    // `key`/`company` in the auth header Booking247 expects.
    return json({ ready: false, message: 'Endpoint ρυθμισμένο, αλλά η πραγματική κλήση API δεν έχει υλοποιηθεί ακόμα.' });
  }

  // ── TODO: real sync, once Booking247's API shape is known ──
  // The safe patient-matching + dedup discipline established in
  // supabase/functions/sync-booking247/index.ts should be reused verbatim:
  //   1. GET bookings from {apiBaseUrl} using `key`/`company` for auth.
  //   2. For each booking, normalizePhone() the customer phone and match
  //      an EXACT existing patient by phone (never fuzzy/substring match on
  //      name alone — see the Γεωργία Γαλανή incident this was built to
  //      prevent). Create a new patient only if no phone match exists.
  //   3. Create/update the appointment, keyed so re-running the sync is
  //      idempotent (e.g. an external Booking247 booking ID stored on the
  //      appointment row, or the same clinic+patient+start_time uniqueness
  //      check sync-booking247 already uses).
  //   4. Record progress in booking247_sync_state so partial failures can
  //      resume instead of re-processing everything.
  void normalizePhone; // referenced above in the plan; keep import used once real code lands here

  return json({ ready: false, message: 'Η απευθείας σύνδεση API δεν έχει ενεργοποιηθεί ακόμα.' });
});
