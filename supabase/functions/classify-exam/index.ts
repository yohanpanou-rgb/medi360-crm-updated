// Supabase Edge Function — 🩺 AI ταξινόμηση εξέτασης ασθενή (Claude API).
//
// Καλείται αφού ανέβει ένα αρχείο εξέτασης (φωτογραφία/PDF) στο bucket
// 'patient-exams' και δημιουργηθεί η γραμμή στο patient_exams: διαβάζει το
// αρχείο, ζητάει από το Claude να προσδιορίσει τον τύπο εξέτασης + μια
// σύντομη περίληψη, και τα αποθηκεύει ως ΠΡΟΤΑΣΗ (ai_type/ai_summary) — η
// θεραπεύτρια τα βλέπει και τα επιβεβαιώνει χειροκίνητα στο UI, ποτέ δεν
// αντικαθιστά ιατρική κρίση.
//
// Called from index.html via:
//   sb.functions.invoke('classify-exam', { body: { exam_id } })
// Returns: { ai_type, ai_summary } ή { error }
//
// Καλείται ΕΠΙΣΗΣ αυτόματα από το gmail-exam-sync (εισαγωγή εξέτασης από
// email πελάτη) με το ίδιο x-cron-secret header που χρησιμοποιούν όλες οι
// αυτοματοποιημένες λειτουργίες — τότε δεν υπάρχει συνδεδεμένος χρήστης,
// οπότε χρησιμοποιείται service-role client (bypass RLS) αντί για το
// RLS-scoped client του χρήστη.
//
// Deploy with:
//   supabase functions deploy classify-exam
// Required secrets: ANTHROPIC_API_KEY (ίδιο με το ai-fix-text),
//   BIRTHDAY_CRON_SECRET (ίδιο κοινό cron secret με τα υπόλοιπα automations)

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

function guessMediaType(fileName: string, blobType: string): string {
  if (blobType && blobType !== 'application/octet-stream') return blobType;
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}

// arrayBuffer → base64, byte-per-byte (ασφαλές για μεγάλα αρχεία — το
// spread σε String.fromCharCode(...bytes) σκάει σε μεγάλα arrays).
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // deno-lint-ignore no-explicit-any
  let supabaseForFailure: any = null;
  let examIdForFailure: string | undefined;

  try {
    const secret = Deno.env.get('BIRTHDAY_CRON_SECRET');
    const isCron = !!secret && req.headers.get('x-cron-secret') === secret;

    let supabase;
    if (isCron) {
      // Αυτόματη κλήση (gmail-exam-sync) — service role, καμία έννοια
      // συνδεδεμένου χρήστη/RLS εδώ.
      supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      supabaseForFailure = supabase;
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

      supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } },
      );
      supabaseForFailure = supabase;

      const { data: { user }, error: userErr } = await supabase.auth.getUser();
      if (userErr || !user) return json({ error: 'Not authenticated' }, 401);

      const { data: profile, error: profileErr } = await supabase
        .from('profiles').select('role').eq('id', user.id).single();
      if (profileErr || !profile) return json({ error: 'Profile not found' }, 403);
      if (!['super_admin', 'clinic_admin', 'therapist'].includes(profile.role)) {
        return json({ error: 'Δεν έχεις δικαίωμα ταξινόμησης εξετάσεων' }, 403);
      }
    }

    const body = await req.json().catch(() => null);
    const examId = body?.exam_id;
    if (!examId) return json({ error: 'Λείπει το exam_id' }, 400);
    examIdForFailure = examId;

    // Το SELECT/UPDATE περνάει μέσα από το RLS του χρήστη — αν η εξέταση
    // ανήκει σε άλλη κλινική, το exam απλά δεν βρίσκεται (δεν χρειάζεται
    // ξεχωριστός έλεγχος clinic_id εδώ).
    const { data: exam, error: examErr } = await supabase
      .from('patient_exams').select('id,storage_path,file_name').eq('id', examId).single();
    if (examErr || !exam) return json({ error: 'Η εξέταση δεν βρέθηκε' }, 404);

    const { data: blob, error: dlErr } = await supabase.storage.from('patient-exams').download(exam.storage_path);
    if (dlErr || !blob) {
      const reason = 'Αποτυχία λήψης αρχείου: ' + (dlErr ? dlErr.message : '');
      console.error('classify-exam', examId, reason);
      await supabase.from('patient_exams').update({ ai_status: 'failed', ai_error: reason }).eq('id', examId);
      return json({ error: reason }, 500);
    }

    const mediaType = guessMediaType(exam.file_name, blob.type);
    const dataB64 = toBase64(await blob.arrayBuffer());
    const isPdf = mediaType === 'application/pdf';

    const systemPrompt = 'Είσαι βοηθός γραμματείας σε κλινική αισθητικής. Θα σου δείξω μια εξέταση ή ιατρικό ' +
      'έγγραφο ασθενή. Προσδιόρισε: (1) τον τύπο της εξέτασης σε 2-5 λέξεις στα ελληνικά ' +
      '(π.χ. "Αιματολογική εξέταση", "Δερματολογική γνωμάτευση", "Αλλεργιολογικό τεστ"), (2) μια σύντομη, ' +
      'περιγραφική περίληψη 1-2 προτάσεων στα ελληνικά. ΜΗΝ δίνεις ιατρική συμβουλή, γνωμάτευση ή διάγνωση — ' +
      'μόνο ουδέτερη περιγραφή του τι δείχνει το έγγραφο, ώστε η γραμματεία να το ταξινομήσει σωστά. ' +
      'Αν το έγγραφο δεν είναι ευανάγνωστο ή δεν μοιάζει με ιατρικό έγγραφο, πες το ρητά στην περίληψη. ' +
      'Απάντησε ΑΚΡΙΒΩΣ σε αυτή τη μορφή, χωρίς κανένα άλλο σχόλιο πριν ή μετά:\n' +
      '[[type]]\n<τύπος εδώ>\n[[summary]]\n<περίληψη εδώ>';

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: isPdf ? 'document' : 'image', source: { type: 'base64', media_type: mediaType, data: dataB64 } },
            { type: 'text', text: 'Ταξινόμησε αυτό το έγγραφο εξέτασης.' },
          ],
        }],
      }),
    });
    const aiData = await aiRes.json();
    if (aiData.error) {
      const reason = 'AI error: ' + (aiData.error.message || JSON.stringify(aiData.error));
      console.error('classify-exam', examId, reason);
      await supabase.from('patient_exams').update({ ai_status: 'failed', ai_error: reason }).eq('id', examId);
      return json({ error: reason }, 502);
    }

    const text = (aiData.content || []).map((c: { text?: string }) => c.text || '').join('');
    const typeMatch = /\[\[type\]\]\s*\n([\s\S]*?)(?=\n\[\[summary\]\]|$)/.exec(text);
    const summaryMatch = /\[\[summary\]\]\s*\n([\s\S]*)$/.exec(text);
    const aiType = typeMatch ? typeMatch[1].trim() : '';
    const aiSummary = summaryMatch ? summaryMatch[1].trim() : '';

    if (!aiType && !aiSummary) {
      const reason = 'Δεν ήταν δυνατή η ανάλυση της απάντησης του AI. Ωμή απάντηση: ' + text.slice(0, 300);
      console.error('classify-exam', examId, reason);
      await supabase.from('patient_exams').update({ ai_status: 'failed', ai_error: reason }).eq('id', examId);
      return json({ error: reason }, 502);
    }

    await supabase.from('patient_exams').update({
      ai_type: aiType || null, ai_summary: aiSummary || null, ai_status: 'done', ai_error: null,
    }).eq('id', examId);

    return json({ ai_type: aiType, ai_summary: aiSummary });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error('classify-exam', examIdForFailure, reason);
    if (supabaseForFailure && examIdForFailure) {
      await supabaseForFailure.from('patient_exams').update({ ai_status: 'failed', ai_error: reason }).eq('id', examIdForFailure).catch(() => {});
    }
    return json({ error: reason }, 500);
  }
});
