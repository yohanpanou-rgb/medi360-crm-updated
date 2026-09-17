// tmp-demo-media — ΠΡΟΣΩΡΙΝΗ βοηθητική function για τη demo κλινική.
//
// Δημιουργεί τα «αρχεία» φωτογραφιών (πριν/μετά) και εξετάσεων της demo κλινικής
// ως SVG και τα ανεβάζει στα buckets patient-photos / patient-exams, στις
// διαδρομές που έχει ήδη γράψει το supabase/seed_demo_clinic.sql στον πίνακα
// backup.demo_media_manifest. Έτσι το CRM τα βρίσκει με createSignedUrl όπως
// κάθε πραγματικό αρχείο.
//
// Καλείται μία φορά, από μέσα από τη βάση (pg_net), με μυστικό κλειδί στο body.
// Μετά τη χρήση αντικαθίσταται με αδρανές stub (η MCP δεν έχει delete).
//
// Body: { key: string, items: [{ bucket, path, kind: 'photo'|'exam', params }] }
import { createClient } from 'npm:@supabase/supabase-js@2';

const KEY = 'demo-media-2026-09';

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Ντετερμινιστικός «τυχαίος» ώστε η ίδια φωτογραφία να βγαίνει ίδια σε κάθε εκτέλεση.
function rng(seed: number) {
  let s = (seed * 9301 + 49297) % 233280;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

// Φωτογραφία: κοντινό «δέρματος» (πρόσωπο) ή περιοχής σώματος (laser), με
// περισσότερες/λιγότερες ατέλειες ανάλογα με ΠΡΙΝ/ΜΕΤΑ. Ξεκάθαρα σχηματική —
// δεν παριστάνει πραγματικό πρόσωπο.
function photoSvg(p: { label: string; after: boolean; service: string; date: string; variant: string; seed: number }) {
  const r = rng(p.seed);
  const laser = p.variant === 'laser';
  const W = 800, H = 800;
  const skin = laser ? ['#f1d3bd', '#e4bfa4'] : ['#f4d7c3', '#e8c2a8'];
  let marks = '';
  if (laser) {
    const n = p.after ? 14 : 110;
    for (let i = 0; i < n; i++) {
      const x = 80 + r() * 640, y = 120 + r() * 520, a = r() * 60 - 30, len = 10 + r() * 14;
      marks += `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + Math.sin(a) * len).toFixed(1)}" y2="${(y + Math.cos(a) * len).toFixed(1)}" stroke="#4a3a30" stroke-width="${(1 + r()).toFixed(1)}" stroke-linecap="round" opacity="${p.after ? 0.35 : 0.85}"/>`;
    }
  } else {
    const n = p.after ? 7 : 34;
    for (let i = 0; i < n; i++) {
      const x = 90 + r() * 620, y = 130 + r() * 500, rad = 4 + r() * 9;
      marks += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(1)}" fill="#c4574f" opacity="${(p.after ? 0.18 : 0.45 + r() * 0.3).toFixed(2)}"/>`;
    }
    if (!p.after) for (let i = 0; i < 12; i++) {
      const x = 90 + r() * 620, y = 130 + r() * 500;
      marks += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(2 + r() * 3).toFixed(1)}" fill="#3a2a22" opacity="0.5"/>`;
    }
  }
  const glow = p.after ? `<ellipse cx="400" cy="380" rx="300" ry="240" fill="url(#gl)" opacity="0.55"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <radialGradient id="sk" cx="45%" cy="40%" r="75%"><stop offset="0" stop-color="${skin[0]}"/><stop offset="1" stop-color="${skin[1]}"/></radialGradient>
  <radialGradient id="gl" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  <filter id="soft"><feGaussianBlur stdDeviation="18"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#sk)"/>
<ellipse cx="560" cy="620" rx="320" ry="220" fill="#d9a98c" opacity="0.35" filter="url(#soft)"/>
<ellipse cx="220" cy="200" rx="260" ry="180" fill="#ffffff" opacity="0.28" filter="url(#soft)"/>
${glow}
${marks}
<text x="400" y="430" text-anchor="middle" font-family="Arial, sans-serif" font-size="150" font-weight="700" fill="#000" opacity="0.06" transform="rotate(-25 400 400)">DEMO</text>
<rect x="0" y="${H - 96}" width="${W}" height="96" fill="#000" opacity="0.55"/>
<text x="28" y="${H - 54}" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#fff">${esc(p.label)} · ${esc(p.date)}</text>
<text x="28" y="${H - 20}" font-family="Arial, sans-serif" font-size="22" fill="#fff" opacity="0.9">${esc(p.service.slice(0, 48))}</text>
</svg>`;
}

// Εξέταση: «σκαναρισμένη» σελίδα εργαστηρίου Α4 με πίνακα αποτελεσμάτων.
function examSvg(p: { patient: string; dob: string; date: string; type: string; rows: string[][]; comment: string }) {
  const W = 800, H = 1130;
  const rows = (p.rows || []).map((row, i) => {
    const y = 330 + i * 40;
    return `<rect x="60" y="${y - 26}" width="680" height="40" fill="${i % 2 ? '#fafafa' : '#fff'}" stroke="#e5e7eb"/>
<text x="72" y="${y}" font-size="15" fill="#222">${esc(row[0])}</text>
<text x="380" y="${y}" font-size="15" font-weight="700" fill="${/[↓↑]|Θετικό/.test(row[1] || '') ? '#b91c1c' : '#222'}">${esc(row[1])}</text>
<text x="500" y="${y}" font-size="14" fill="#444">${esc(row[2])}</text>
<text x="590" y="${y}" font-size="14" fill="#444">${esc(row[3])}</text>`;
  }).join('\n');
  const cy = 330 + (p.rows?.length || 0) * 40 + 30;
  const words = (p.comment || '').split(' ');
  const lines: string[] = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > 78) { lines.push(cur.trim()); cur = w; } else cur += ' ' + w; }
  if (cur.trim()) lines.push(cur.trim());
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, Helvetica, sans-serif">
<rect width="${W}" height="${H}" fill="#f3f4f6"/>
<rect x="20" y="20" width="${W - 40}" height="${H - 40}" fill="#fff" stroke="#d1d5db"/>
<text x="60" y="80" font-size="26" font-weight="700" fill="#111">Βιοπαθολογικό Εργαστήριο «Υγεία Demo»</text>
<text x="60" y="106" font-size="13" fill="#666">Λ. Βάρης-Κορωπίου 120, Κορωπί · Τηλ. 210 000 0000 · Δείγμα επίδειξης — μη πραγματικά αποτελέσματα</text>
<line x1="60" y1="124" x2="740" y2="124" stroke="#2B6CB0" stroke-width="3"/>
<text x="60" y="166" font-size="16" fill="#222"><tspan font-weight="700">Ασθενής:</tspan> ${esc(p.patient)}</text>
<text x="440" y="166" font-size="16" fill="#222"><tspan font-weight="700">Ημ. Γέννησης:</tspan> ${esc(p.dob)}</text>
<text x="60" y="194" font-size="16" fill="#222"><tspan font-weight="700">Ημ. Εξέτασης:</tspan> ${esc(p.date)}</text>
<text x="440" y="194" font-size="16" fill="#222"><tspan font-weight="700">Παραπέμπων:</tspan> Δρ. Ε. Παπαδάκη</text>
<text x="60" y="222" font-size="16" fill="#222"><tspan font-weight="700">Είδος:</tspan> ${esc(p.type)}</text>
<rect x="60" y="264" width="680" height="40" fill="#e8eef7" stroke="#cbd5e1"/>
<text x="72" y="290" font-size="14" font-weight="700" fill="#1e3a5f">Εξέταση</text>
<text x="380" y="290" font-size="14" font-weight="700" fill="#1e3a5f">Αποτέλεσμα</text>
<text x="500" y="290" font-size="14" font-weight="700" fill="#1e3a5f">Μονάδες</text>
<text x="590" y="290" font-size="14" font-weight="700" fill="#1e3a5f">Τιμές αναφοράς</text>
${rows}
<text x="60" y="${cy}" font-size="15" font-weight="700" fill="#222">Σχόλιο:</text>
${lines.map((l, i) => `<text x="130" y="${cy + i * 22}" font-size="15" fill="#333">${esc(l)}</text>`).join('\n')}
<text x="400" y="600" text-anchor="middle" font-size="140" font-weight="700" fill="#b91c1c" opacity="0.07" transform="rotate(-25 400 600)">DEMO</text>
<line x1="60" y1="${H - 110}" x2="740" y2="${H - 110}" stroke="#e5e7eb"/>
<text x="60" y="${H - 84}" font-size="12" fill="#888">Εικονικό έγγραφο για σκοπούς επίδειξης του Medi360 CRM.</text>
<text x="60" y="${H - 64}" font-size="12" fill="#888">Υπογραφή: Δρ. Α. Δημόπουλος, Βιοπαθολόγος (demo)</text>
</svg>`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: { key?: string; items?: Array<{ bucket: string; path: string; kind: string; params: Record<string, unknown> }> } = {};
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  if (body.key !== KEY) return new Response('forbidden', { status: 403 });

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const failed: Array<{ path: string; error: string }> = [];
  let ok = 0;
  for (const it of body.items || []) {
    try {
      // deno-lint-ignore no-explicit-any
      const svg = it.kind === 'photo' ? photoSvg(it.params as any) : examSvg(it.params as any);
      const { error } = await sb.storage.from(it.bucket)
        .upload(it.path, new Blob([svg], { type: 'image/svg+xml' }), { contentType: 'image/svg+xml', upsert: true });
      if (error) failed.push({ path: it.path, error: error.message }); else ok++;
    } catch (e) {
      failed.push({ path: it.path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return new Response(JSON.stringify({ ok, failed }), { headers: { 'Content-Type': 'application/json' } });
});
