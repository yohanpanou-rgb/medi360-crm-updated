// Supabase Edge Function — corrects Greek spelling/typos in free-typed text
// fields of the Consultation Form (Παρατηρήσεις Θεραπευτή, Σημειώσεις) before
// they get saved and emailed to the patient. Only touches spelling/typos, not
// wording or meaning — everything else in the form (services, products,
// skin-type) is picked from curated dropdown lists already, so it doesn't
// need this.
//
// Called from index.html via:
//   sb.functions.invoke('ai-fix-text', { body: { fields: { notes: '...', additionalNotes: '...' } } })
// Returns: { fields: { notes: 'corrected...', additionalNotes: 'corrected...' } }
// (only the keys that were actually sent are returned; if parsing the model's
// reply fails for any reason, returns { fields: {} } and the caller keeps the
// operator's original text rather than risk overwriting it with garbage.)
//
// Deploy with:
//   supabase functions deploy ai-fix-text
//
// Required secret (not shared with the other functions — set this one up):
//   ANTHROPIC_API_KEY

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
      .from('profiles').select('role').eq('id', user.id).single();
    if (profileErr || !profile) return json({ error: 'Profile not found' }, 403);
    if (!['super_admin', 'clinic_admin', 'therapist'].includes(profile.role)) {
      return json({ error: 'Δεν έχεις δικαίωμα χρήσης της διόρθωσης κειμένου' }, 403);
    }

    const body = await req.json().catch(() => null);
    const fields = body?.fields;
    if (!fields || typeof fields !== 'object' || !Object.keys(fields).length) {
      return json({ error: 'Λείπουν τα fields' }, 400);
    }

    const keys = Object.keys(fields).filter((k) => typeof fields[k] === 'string' && fields[k].trim());
    if (!keys.length) return json({ fields: {} });

    const promptBody = keys.map((k) => `[[${k}]]\n${fields[k]}`).join('\n\n');
    const systemPrompt = 'Διόρθωσε ΜΟΝΟ ορθογραφικά και τυπογραφικά λάθη στα παρακάτω ελληνικά κείμενα. ' +
      'Μην αλλάξεις το νόημα, το ύφος, ή τη δομή των προτάσεων, και μην προσθέσεις ή αφαιρέσεις πληροφορία. ' +
      'Κάθε κείμενο ξεκινάει με μία ετικέτα σε διπλές αγκύλες, π.χ. [[notes]]. ' +
      'Επίστρεψε ΑΚΡΙΒΩΣ την ίδια μορφή (ίδιες ετικέτες, μία ανά κείμενο, με το διορθωμένο κείμενο από κάτω), ' +
      'χωρίς κανένα άλλο σχόλιο πριν ή μετά.';

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: promptBody }],
      }),
    });
    const aiData = await aiRes.json();
    if (aiData.error) return json({ error: 'AI error: ' + (aiData.error.message || JSON.stringify(aiData.error)) }, 502);

    const text = (aiData.content || []).map((c: { text?: string }) => c.text || '').join('');
    const outFields: Record<string, string> = {};
    const re = /\[\[([^\]]+)\]\]\s*\n([\s\S]*?)(?=\n\[\[|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      outFields[m[1].trim()] = m[2].trim();
    }

    return json({ fields: outFields });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});
