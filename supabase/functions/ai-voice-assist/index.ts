// Supabase Edge Function — AI βοήθεια για τις φωνητικές εντολές του CRM.
// Όταν το keyword-matching του processVoiceCommand (index.html) δεν καταλάβει
// τη φράση, στέλνει εδώ το transcript και το Claude τη μετατρέπει σε μία
// αυστηρά περιορισμένη ενέργεια (πλοήγηση / άνοιγμα φόρμας / αναζήτηση /
// απάντηση κειμένου). Το frontend εκτελεί ΜΟΝΟ ενέργειες από τη λίστα
// επιτρεπτών — ό,τι άλλο επιστραφεί αγνοείται.
//
// Called from index.html via:
//   sb.functions.invoke('ai-voice-assist', { body: { transcript: '...', context: { page: 'dashboard' } } })
// Returns: { action: { action: 'navigate'|'open_modal'|'search'|'answer', page?, modal?, query?, say } }
//
// Deploy with:
//   supabase functions deploy ai-voice-assist
//
// Required secret (ήδη ορισμένο για το ai-fix-text):
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

const PAGES = ['dashboard', 'patients', 'appointments', 'calendar', 'sms', 'laser', 'consultations', 'consents', 'reports', 'staff-services', 'settings'];
const MODALS = ['new-appt', 'new-patient', 'new-laser'];

const SYSTEM_PROMPT = `Είσαι ο φωνητικός βοηθός ενός CRM ινστιτούτου αισθητικής (Beauty Line).
Ο χρήστης είπε μια φράση στα ελληνικά (μεταγραφή ομιλίας — μπορεί να έχει λάθη αναγνώρισης ή greeklish).
Μετάτρεψέ τη σε ΜΙΑ ενέργεια, απαντώντας ΜΟΝΟ με ένα JSON αντικείμενο, χωρίς άλλο κείμενο και χωρίς code fences.

Διαθέσιμες ενέργειες:
1. {"action":"navigate","page":"...","say":"σύντομη ελληνική επιβεβαίωση"}
   Σελίδες: dashboard (αρχική/στατιστικά), patients (λίστα ασθενών/πελατών), appointments (λίστα ραντεβού),
   calendar (εβδομαδιαίο πρόγραμμα/ημερολόγιο), sms (SMS & αυτοματισμοί), laser (φόρμες laser αποτρίχωσης),
   consultations (φόρμες consultation), consents (συναινέσεις/υπογραφές), reports (αναφορές/οικονομικά),
   staff-services (προσωπικό, υπηρεσίες, ωράρια, άδειες), settings (ρυθμίσεις).
2. {"action":"open_modal","modal":"...","say":"..."}
   Modals: new-appt (νέο ραντεβού), new-patient (νέος ασθενής/πελάτης), new-laser (νέα φόρμα laser).
3. {"action":"search","query":"όνομα ή τηλέφωνο","say":"..."}
   Όταν ψάχνει συγκεκριμένο ασθενή/πελάτη. Στο query βάλε ΜΟΝΟ το όνομα ή το τηλέφωνο, με ελληνικούς
   χαρακτήρες αν το όνομα είναι ελληνικό (μετέτρεψε τυχόν greeklish, π.χ. "maria" → "μαρια").
4. {"action":"answer","say":"σύντομη ελληνική απάντηση (μέχρι 2 προτάσεις)"}
   Για γενικές ερωτήσεις για το CRM ή όταν τίποτα άλλο δεν ταιριάζει. Αν δεν καταλαβαίνεις τη φράση,
   πες τι μπορείς να κάνεις.

Κανόνες: μη μαντεύεις τηλέφωνα/ονόματα που δεν ειπώθηκαν· προτίμησε navigate/search/open_modal όταν
υπάρχει σαφής πρόθεση· το "say" πάντα στα ελληνικά, φυσικό και σύντομο.`;

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
    if (!['super_admin', 'clinic_admin', 'therapist', 'receptionist'].includes(profile.role)) {
      return json({ error: 'Δεν έχεις δικαίωμα χρήσης του φωνητικού βοηθού' }, 403);
    }

    const body = await req.json().catch(() => null);
    const transcript = (body?.transcript ?? '').toString().trim().slice(0, 500);
    if (!transcript) return json({ error: 'Λείπει το transcript' }, 400);
    const currentPage = (body?.context?.page ?? '').toString().slice(0, 50);

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Τρέχουσα σελίδα: ${currentPage || 'άγνωστη'}\nΦράση χρήστη: "${transcript}"`,
        }],
      }),
    });
    const aiData = await aiRes.json();
    if (aiData.error) return json({ error: 'AI error: ' + (aiData.error.message || JSON.stringify(aiData.error)) }, 502);

    const text = (aiData.content || []).map((c: { text?: string }) => c.text || '').join('').trim();
    // Απομόνωση του JSON ακόμα κι αν το μοντέλο προσθέσει fences ή σχόλιο.
    const match = text.match(/\{[\s\S]*\}/);
    let action: Record<string, unknown> | null = null;
    try { action = match ? JSON.parse(match[0]) : null; } catch { action = null; }

    // Server-side validation: μόνο επιτρεπτές ενέργειες/τιμές φεύγουν προς το frontend.
    if (!action || typeof action !== 'object') return json({ action: null });
    const kind = action.action;
    const say = typeof action.say === 'string' ? action.say.slice(0, 300) : '';
    if (kind === 'navigate' && PAGES.includes(action.page as string)) {
      return json({ action: { action: 'navigate', page: action.page, say } });
    }
    if (kind === 'open_modal' && MODALS.includes(action.modal as string)) {
      return json({ action: { action: 'open_modal', modal: action.modal, say } });
    }
    if (kind === 'search' && typeof action.query === 'string' && action.query.trim()) {
      return json({ action: { action: 'search', query: action.query.trim().slice(0, 120), say } });
    }
    if (kind === 'answer' && say) {
      return json({ action: { action: 'answer', say } });
    }
    return json({ action: null });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});
