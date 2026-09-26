// Supabase Edge Function — ΔΟΚΙΜΑΣΤΙΚΟΣ έλεγχος σύνδεσης με το API Ιατρών της ΗΔΙΚΑ
// (Ηλεκτρονική Συνταγογράφηση, UAT: https://testeps.e-prescription.gr/docapiv2).
//
// Γιατί υπάρχει: το περιβάλλον ανάπτυξης δεν έχει δικτυακή πρόσβαση στο
// e-prescription.gr, ενώ οι Edge Functions έχουν. Πριν γραφτεί η πραγματική
// διασύνδεση, εδώ επαληθεύουμε: (α) ότι ο server απαντά, (β) με ποιο όνομα
// header δέχεται το APPLICATION API KEY (η ΗΔΙΚΑ γράφει «στους headers» χωρίς
// να ονομάζει το header), (γ) ότι τα credentials του δοκιμαστικού χρήστη
// περνούν το authentication και το /api/v1/me δημιουργεί «ενεργή σύνδεση».
//
// Ασφάλεια: ΔΕΝ αποθηκεύει τίποτα. Το API key και τα credentials έρχονται είτε
// από secrets (IDIKA_API_KEY, IDIKA_USER, IDIKA_PASS) είτε, για τη δοκιμή, από
// το body της κλήσης. Auth κλήσης: x-cron-secret = BIRTHDAY_CRON_SECRET (όπως
// όλα τα εσωτερικά automations). Δεν καλείται από το frontend.
//
// Κλήση (SQL, μέσω pg_net):
//   select net.http_post('https://<proj>.supabase.co/functions/v1/idika-probe',
//     headers := '{"Content-Type":"application/json","x-cron-secret":"..."}'::jsonb,
//     body := '{"mode":"headers"}'::jsonb);
// Επιστρέφει: { base, results: [{label, header, auth, status, ms, body}] }

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' };
const DEFAULT_BASE = 'https://testeps.e-prescription.gr/docapiv2';
// Υποψήφια ονόματα header για το application key. Η σωστή τιμή αναγνωρίζεται
// από την ΑΛΛΑΓΗ του μηνύματος: χωρίς/λάθος header → "604::You must provide a
// valid api key", με σωστό header → 401 (χωρίς credentials) ή 601/200.
const HEADER_CANDIDATES = ['apikey', 'api-key', 'api_key', 'x-api-key', 'x-apikey', 'applicationkey', 'application-key', 'appkey', 'app-key', 'key', 'x-application-key'];

type ProbeResult = { label: string; header: string | null; auth: boolean; status: number | string; ms: number; body: string };

// Αποτέλεσμα 26/09/2026 (UAT): το gateway (IBM) θέλει Basic auth χρήστη ΗΣ και το API
// διαβάζει το application key από το header `api-key`. Με 'apikey'/'x-api-key' κ.λπ. → 604.
let BODY_LIMIT = 400; // mode 'path' με full:true → έως 400 KB (για σελίδες Wiki / masterdata)

async function probe(url: string, headerName: string | null, apiKey: string, user: string, pass: string, label: string): Promise<ProbeResult> {
  const headers: Record<string, string> = { Accept: 'application/xml, application/json;q=0.9, */*;q=0.5' };
  if (headerName) headers[headerName] = apiKey;
  const auth = !!(user && pass);
  if (auth) headers['Authorization'] = 'Basic ' + btoa(`${user}:${pass}`);
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    const raw = await r.text();
    const text = BODY_LIMIT > 400 ? raw : raw.replace(/\s+/g, ' ').trim();
    return { label, header: headerName, auth, status: r.status, ms: Date.now() - t0, body: text.slice(0, BODY_LIMIT) };
  } catch (e) {
    return { label, header: headerName, auth, status: 'ERR', ms: Date.now() - t0, body: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const h = { ...cors, 'Content-Type': 'application/json' };
  try {
    const secret = Deno.env.get('BIRTHDAY_CRON_SECRET');
    if (!secret || req.headers.get('x-cron-secret') !== secret) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: h });

    const body = await req.json().catch(() => ({}));
    const base = String(body.base || DEFAULT_BASE).replace(/\/$/, '');
    const apiKey = String(body.api_key || Deno.env.get('IDIKA_API_KEY') || '');
    const user = String(body.username || Deno.env.get('IDIKA_USER') || '');
    const pass = String(body.password || Deno.env.get('IDIKA_PASS') || '');
    const mode = String(body.mode || 'headers'); // 'headers' | 'me' | 'path'
    const path = String(body.path || '/api/v1/me');
    BODY_LIMIT = body.full ? 400 * 1024 : 400;
    const results: ProbeResult[] = [];

    if (mode === 'headers') {
      // 1) Χωρίς κανένα header → περιμένουμε 604 (αποδεικνύει ότι φτάνουμε στο API).
      results.push(await probe(base + path, null, apiKey, '', '', 'no-key'));
      // 2) Κάθε υποψήφιο header χωρίς credentials → όποιο ΔΕΝ δώσει 604 είναι το σωστό.
      if (apiKey) {
        for (const name of HEADER_CANDIDATES) results.push(await probe(base + path, name, apiKey, '', '', 'key-only'));
      }
    } else if (mode === 'me' || mode === 'path') {
      // Πλήρης κλήση με το header που δίνεται (ή apikey) και Basic auth.
      const name = String(body.header || 'api-key');
      results.push(await probe(base + path, name, apiKey, user, pass, mode));
    }

    return new Response(JSON.stringify({ ok: true, base, path, mode, has_key: !!apiKey, has_credentials: !!(user && pass), results }), { headers: h });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: h });
  }
});
