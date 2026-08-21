// Supabase Edge Function — 🧾 Έκδοση myDATA ηλεκτρονικής απόδειξης λιανικής
// μέσω του πάροχου Wrapp (myDATA ΥΠΑΗΕΣ, ΑΑΔΕ 029), όταν η θεραπεύτρια/γραμματεία
// πατήσει το κουμπί «Έκδοση Απόδειξης» σε ένα ολοκληρωμένο ραντεβού.
//
// ΣΚΟΠΙΜΑ όχι αυτόματο στο status='completed' — μια λάθος εκδομένη απόδειξη
// χρειάζεται πιστωτικό/ακυρωτικό παραστατικό για διόρθωση, όχι απλό undo. Το
// ποσό/τρόπος πληρωμής έρχονται από τον χρήστη (προσυμπληρωμένα από την τιμή
// του ραντεβού, αλλά επεξεργάσιμα) — βλ. bindApptReceiptButton() στο index.html.
//
// TODO πριν ενεργοποιηθεί πραγματική έκδοση (βλ. plan — δεν μπορούμε να τα
// μαντέψουμε):
//   1. Λογαριασμός Wrapp (wrapp.ai) + πραγματικό API key → WRAPP_API_KEY secret.
//   2. Κωδικός κατηγορίας εσόδων ΑΑΔΕ + ΦΠΑ ανά υπηρεσία, από τον λογιστή της
//      κλινικής — ΔΕΝ μαντεύουμε φορολογικό κωδικό εδώ.
//   3. Το πραγματικό endpoint/request shape του Wrapp partner API, μόλις
//      υπάρχει λογαριασμός — τότε αντικαθιστά το placeholder fetch() παρακάτω.
//
// Deploy with:
//   supabase functions deploy issue-receipt
// Required secrets: WRAPP_API_KEY (μόλις υπάρχει λογαριασμός Wrapp),
//   BIRTHDAY_CRON_SECRET (ίδιο κοινό cron secret με τα υπόλοιπα automations,
//   χρησιμοποιείται εδώ μόνο για το dual-auth pattern — δεν υπάρχει σήμερα
//   κάποιο cron που καλεί αυτό το function, η έκδοση είναι πάντα χειροκίνητη).

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let entityIdForFailure: string | undefined;
  let entityTableForFailure: string | undefined;
  // deno-lint-ignore no-explicit-any
  let supabaseSvc: any = null;

  try {
    const secret = Deno.env.get('BIRTHDAY_CRON_SECRET');
    const isCron = !!secret && req.headers.get('x-cron-secret') === secret;

    supabaseSvc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    if (!isCron) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

      const userClient = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: { user }, error: userErr } = await userClient.auth.getUser();
      if (userErr || !user) return json({ error: 'Not authenticated' }, 401);

      const { data: profile, error: profileErr } = await supabaseSvc
        .from('profiles').select('role').eq('id', user.id).single();
      if (profileErr || !profile) return json({ error: 'Profile not found' }, 403);
      // Οικονομική/φορολογική ενέργεια. Θεραπεύτριες περιλαμβάνονται ΜΟΝΟ γιατί
      // η Πώληση Καλλυντικού (index.html, renderProductSale) επιτρέπεται και σε
      // αυτές — πουλάνε προϊόντα απευθείας στον πελάτη.
      if (!['super_admin', 'clinic_admin', 'receptionist', 'therapist'].includes(profile.role)) {
        return json({ error: 'Δεν έχεις δικαίωμα έκδοσης αποδείξεων' }, 403);
      }
    }

    const body = await req.json().catch(() => null);
    const amount = typeof body?.amount === 'number' ? body.amount : parseFloat(body?.amount);
    const paymentMethod = body?.payment_method === 'card' ? 'card' : 'cash';
    if (isNaN(amount) || amount < 0) return json({ error: 'Μη έγκυρο ποσό' }, 400);

    // Ένα από τα τρία — ραντεβού, πακέτο, ή μεμονωμένη πώληση καλλυντικού.
    // Ίδια λογική και για τα τρία: SELECT (με receipt_mark), idempotency guard,
    // UPDATE receipt_* πάνω στην ίδια γραμμή.
    let table: string; let entityId: string; let clinicId: string;
    if (body?.appointment_id) {
      table = 'appointments'; entityId = body.appointment_id;
      const { data, error: e } = await supabaseSvc.from('appointments').select('id,clinic_id,receipt_mark').eq('id', entityId).single();
      if (e || !data) return json({ error: 'Το ραντεβού δεν βρέθηκε' }, 404);
      if (data.receipt_mark) return json({ error: `Έχει ήδη εκδοθεί απόδειξη (#${data.receipt_mark}) για αυτό το ραντεβού` }, 409);
      clinicId = data.clinic_id;
    } else if (body?.package_id) {
      table = 'patient_packages'; entityId = body.package_id;
      const { data, error: e } = await supabaseSvc.from('patient_packages').select('id,clinic_id,receipt_mark').eq('id', entityId).single();
      if (e || !data) return json({ error: 'Το πακέτο δεν βρέθηκε' }, 404);
      if (data.receipt_mark) return json({ error: `Έχει ήδη εκδοθεί απόδειξη (#${data.receipt_mark}) για αυτό το πακέτο` }, 409);
      clinicId = data.clinic_id;
    } else if (body?.product_sale_id) {
      table = 'product_sales'; entityId = body.product_sale_id;
      const { data, error: e } = await supabaseSvc.from('product_sales').select('id,clinic_id,receipt_mark').eq('id', entityId).single();
      if (e || !data) return json({ error: 'Η πώληση δεν βρέθηκε' }, 404);
      if (data.receipt_mark) return json({ error: `Έχει ήδη εκδοθεί απόδειξη (#${data.receipt_mark}) για αυτή την πώληση` }, 409);
      clinicId = data.clinic_id;
    } else {
      return json({ error: 'Λείπει appointment_id, package_id ή product_sale_id' }, 400);
    }
    entityIdForFailure = entityId;
    entityTableForFailure = table;

    const { data: clinic, error: clinicErr } = await supabaseSvc
      .from('clinics').select('id,integrations').eq('id', clinicId).single();
    if (clinicErr || !clinic) return json({ error: 'Η κλινική δεν βρέθηκε' }, 404);

    if (!clinic.integrations?.mydata_enabled) {
      return json({ error: 'Η αυτόματη έκδοση αποδείξεων είναι απενεργοποιημένη (Ρυθμίσεις → Ενσωματώσεις → myDATA)' }, 400);
    }

    const apiKey = Deno.env.get('WRAPP_API_KEY');
    if (!apiKey) {
      const reason = 'Δεν έχει ρυθμιστεί ακόμα το κλειδί σύνδεσης με το Wrapp (WRAPP_API_KEY) — χρειάζεται πρώτα λογαριασμός Wrapp.';
      await supabaseSvc.from(table).update({ receipt_error: reason }).eq('id', entityId);
      return json({ error: reason }, 501);
    }

    // ── TODO: πραγματική κλήση στο Wrapp REST API ──
    // Placeholder μέχρι να έχουμε τα πραγματικά partner API docs (prerequisite
    // #3 πιο πάνω). Το shape θα είναι κάτι σαν:
    //   const res = await fetch(`${WRAPP_API_BASE_URL}/receipts`, {
    //     method: 'POST',
    //     headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    //     body: JSON.stringify({ amount, payment_method: paymentMethod, /* + κωδικός κατηγορίας ΑΑΔΕ/ΦΠΑ όταν μας τα δώσει ο λογιστής */ }),
    //   });
    //   const data = await res.json();
    //   if (!res.ok || data.error) throw new Error(data.error || `Wrapp API error (${res.status})`);
    //   const receiptMark = data.mark || data.invoiceMark;
    const reason = 'Η πραγματική έκδοση μέσω Wrapp δεν έχει ενεργοποιηθεί ακόμα (λείπει λογαριασμός/API docs) — δες τα TODO στην αρχή του αρχείου.';
    await supabaseSvc.from(table).update({ receipt_error: reason }).eq('id', entityId);
    return json({ error: reason }, 501);

    // Όταν ενεργοποιηθεί το πραγματικό API call, το επιτυχές branch θα κάνει:
    //   await supabaseSvc.from(table).update({
    //     receipt_mark: receiptMark, receipt_issued_at: new Date().toISOString(),
    //     receipt_amount: amount, receipt_payment_method: paymentMethod, receipt_error: null,
    //   }).eq('id', entityId);
    //   return json({ receipt_mark: receiptMark });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (supabaseSvc && entityIdForFailure && entityTableForFailure) {
      await supabaseSvc.from(entityTableForFailure).update({ receipt_error: reason }).eq('id', entityIdForFailure).catch(() => {});
    }
    return json({ error: reason }, 500);
  }
});
