// Supabase Edge Function — «Ρώτα το CRM»: AI βοηθός στατιστικών με φυσική γλώσσα.
//
// Ο χρήστης ρωτάει ελεύθερα («πόσα Hydrafacial έγιναν τον Σεπτέμβριο;», «ποια
// μέρα είναι η πιο αδύναμη;», «πόσοι πελάτες δεν έχουν έρθει 6 μήνες;») και το
// Claude επιλέγει ποιο από τα ΠΡΟΚΑΘΟΡΙΣΜΕΝΑ εργαλεία θα καλέσει και με τι
// παραμέτρους. ΔΕΝ γράφει SQL. Κάθε εργαλείο:
//   • τρέχει με το JWT του συνδεδεμένου χρήστη → RLS → βλέπει μόνο την κλινική του
//   • επιστρέφει ΜΟΝΟ αθροίσματα/ποσοστά/ονόματα υπηρεσιών & προσωπικού —
//     ΠΟΤΕ ονόματα, τηλέφωνα ή άλλα στοιχεία πελατών (GDPR)
//   • χρησιμοποιεί τους ίδιους ορισμούς με τη σελίδα Αναφορών (έσοδα = τιμή
//     ΟΛΟΚΛΗΡΩΜΕΝΩΝ ραντεβού, εσωτερικά ραντεβού εξαιρούνται)
//
// Called from index.html:
//   sb.functions.invoke('crm-assistant', { body: { messages:[{role,content}], clinic_id? } })
// Returns: { reply: string(markdown), tool_calls: [{name, input}], usage }
//
// Για δοκιμές/αυτοματισμούς: header x-cron-secret = BIRTHDAY_CRON_SECRET + body.clinic_id
// (τρέχει με service role, χωρίς χρήστη).
//
// Required secrets: ANTHROPIC_API_KEY (ήδη ορισμένο). Deploy:
//   supabase functions deploy crm-assistant --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};
const MODEL = 'claude-sonnet-5';
const MAX_TOOL_ROUNDS = 8;
const MAX_ROWS = 20000;
const TZ = 'Europe/Athens';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

// ── Ημερομηνίες σε ώρα Ελλάδας ──────────────────────────────────────────────
function athensParts(d: Date) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const hour = parseInt(p.hour === '24' ? '0' : p.hour, 10);
  return { date: `${p.year}-${p.month}-${p.day}`, hour, weekday: p.weekday, month: `${p.year}-${p.month}` };
}
const WEEKDAY_GR: Record<string, string> = { Mon: 'Δευτέρα', Tue: 'Τρίτη', Wed: 'Τετάρτη', Thu: 'Πέμπτη', Fri: 'Παρασκευή', Sat: 'Σάββατο', Sun: 'Κυριακή' };
const WEEKDAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Αρχή ημέρας (00:00 Αθήνα) ως UTC ISO — δοκιμάζει +03:00 (θερινή) και +02:00.
function athensDayStartISO(dateStr: string): string {
  for (const off of ['+03:00', '+02:00']) {
    const d = new Date(`${dateStr}T00:00:00${off}`);
    if (!isNaN(d.getTime()) && athensParts(d).date === dateStr && athensParts(d).hour === 0) return d.toISOString();
  }
  return new Date(`${dateStr}T00:00:00Z`).toISOString();
}
function athensDayEndISO(dateStr: string): string { // αποκλειστικό άνω όριο = αρχή της επόμενης μέρας
  const d = new Date(`${dateStr}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
  return athensDayStartISO(d.toISOString().slice(0, 10));
}
function isoWeek(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const wk = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}
function validDate(s: unknown): s is string { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime()); }
function norm(s: unknown): string { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); }
function round2(n: number) { return Math.round(n * 100) / 100; }

// Παίρνει όλες τις γραμμές ενός query με σελιδοποίηση (PostgREST cap 1000/σελίδα).
async function fetchAll(makeQuery: (from: number, to: number) => any, max = MAX_ROWS): Promise<any[]> {
  const out: any[] = [];
  const page = 1000;
  for (let from = 0; from < max; from += page) {
    const { data, error } = await makeQuery(from, Math.min(from + page - 1, max - 1));
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < page) break;
  }
  return out;
}

// ── Εργαλεία ───────────────────────────────────────────────────────────────
type Ctx = { sb: any; cid: string; services: any[]; staff: any[]; branches: any[] };

const TOOLS = [
  {
    name: 'appointments_stats',
    description: 'Στατιστικά ραντεβού/θεραπειών για ένα διάστημα: πλήθος, ολοκληρωμένα, ακυρώσεις, no-show, έσοδα (τιμή ολοκληρωμένων), μοναδικοί πελάτες, μέσο καλάθι. Προαιρετικά φίλτρο υπηρεσίας/θεραπευτή/υποκαταστήματος και ομαδοποίηση (ανά ημέρα, εβδομάδα, μήνα, ημέρα εβδομάδας, ώρα, ημέρα εβδομάδας+ώρα, υπηρεσία, κατηγορία υπηρεσίας, θεραπευτή, κατάσταση, υποκατάστημα, πηγή κράτησης, νέος/επαναλαμβανόμενος πελάτης). Για συγκρίσεις περιόδων κάλεσέ το δύο φορές.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'YYYY-MM-DD (ώρα Ελλάδας, συμπεριλαμβάνεται)' },
        date_to: { type: 'string', description: 'YYYY-MM-DD (συμπεριλαμβάνεται)' },
        service_contains: { type: 'string', description: 'Υποσυμβολοσειρά ονόματος υπηρεσίας (χωρίς τόνους/πεζά αδιάφορα), π.χ. "hydrafacial", "laser", "botox"' },
        service_category: { type: 'string', description: 'Κατηγορία υπηρεσίας όπως στη λίστα υπηρεσιών' },
        therapist_contains: { type: 'string', description: 'Μέρος ονόματος θεραπευτή' },
        branch_contains: { type: 'string', description: 'Μέρος ονόματος υποκαταστήματος' },
        statuses: { type: 'array', items: { type: 'string', enum: ['booked', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show', 'rescheduled'] }, description: 'Αν λείπει: όλα' },
        group_by: { type: 'string', enum: ['none', 'day', 'week', 'month', 'weekday', 'hour', 'weekday_hour', 'service', 'service_category', 'therapist', 'status', 'branch', 'booking_source', 'new_vs_returning'] },
        limit: { type: 'integer', description: 'Μέγιστες γραμμές ομαδοποίησης (default 40)' },
      },
      required: ['date_from', 'date_to'],
    },
  },
  {
    name: 'patients_stats',
    description: 'Στατιστικά πελατολογίου: σύνολο, νέοι πελάτες σε διάστημα, ενεργοί/ανενεργοί (χωρίς ραντεβού για Χ μήνες), που δεν ήρθαν ποτέ, GDPR, marketing opt-in, φοιτητές, ανά πηγή, ανά πόλη, ανά φύλο, ηλικιακές ομάδες, γενέθλια επόμενων ημερών (μόνο πλήθος), με κριτική Google. Χωρίς προσωπικά στοιχεία.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'YYYY-MM-DD για "νέοι πελάτες" (ημερομηνία εγγραφής)' },
        date_to: { type: 'string' },
        inactive_months: { type: 'integer', description: 'Μήνες χωρίς ραντεβού για να θεωρηθεί ανενεργός (default 6)' },
      },
    },
  },
  {
    name: 'retention_stats',
    description: 'Επιστροφή/διατήρηση πελατών: από τους πελάτες με ΠΡΩΤΟ ραντεβού μέσα στο διάστημα, τι ποσοστό ξαναήρθε μέσα σε 90/180/365 ημέρες, μέσος αριθμός επισκέψεων, ποσοστό ραντεβού από επαναλαμβανόμενους πελάτες.',
    input_schema: { type: 'object', properties: { date_from: { type: 'string' }, date_to: { type: 'string' } }, required: ['date_from', 'date_to'] },
  },
  {
    name: 'product_sales_stats',
    description: 'Πωλήσεις καλλυντικών/προϊόντων σε διάστημα: πλήθος, τζίρος, ανά προϊόν, ανά μήνα, ανά τρόπο πληρωμής.',
    input_schema: { type: 'object', properties: { date_from: { type: 'string' }, date_to: { type: 'string' }, group_by: { type: 'string', enum: ['none', 'product', 'month', 'payment_method'] } }, required: ['date_from', 'date_to'] },
  },
  {
    name: 'packages_stats',
    description: 'Πακέτα συνεδριών που πουλήθηκαν σε διάστημα (πακέτα laser + γενικά πακέτα): πλήθος, έσοδα, ανά όνομα πακέτου, ανά μήνα.',
    input_schema: { type: 'object', properties: { date_from: { type: 'string' }, date_to: { type: 'string' } }, required: ['date_from', 'date_to'] },
  },
  {
    name: 'communications_stats',
    description: 'Αυτόματα μηνύματα (SMS/email) που στάλθηκαν: ανά τύπο (επιβεβαίωση, υπενθύμιση, αίτημα αξιολόγησης, γενέθλια κ.λπ.), κανάλι, κατάσταση, μήνα.',
    input_schema: { type: 'object', properties: { date_from: { type: 'string' }, date_to: { type: 'string' }, group_by: { type: 'string', enum: ['type', 'channel', 'status', 'month', 'type_channel'] } }, required: ['date_from', 'date_to'] },
  },
  {
    name: 'reviews_stats',
    description: 'Κριτικές Google: σύνολο, μέση βαθμολογία, ανά αστέρια, ανά μήνα, πόσες τις τελευταίες 30/90 ημέρες, πόσες συνδεδεμένες με πελάτη.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function loadAppointments(ctx: Ctx, from: string, to: string) {
  return fetchAll((a, b) => ctx.sb.from('appointments')
    .select('patient_id,therapist_id,branch_id,service_name,start_time,status,price,from_booking,created_at,package_id,general_package_id')
    .eq('clinic_id', ctx.cid).eq('is_internal', false)
    .gte('start_time', athensDayStartISO(from)).lt('start_time', athensDayEndISO(to))
    .order('start_time', { ascending: true }).range(a, b));
}

function summarize(list: any[]) {
  const completed = list.filter(a => a.status === 'completed');
  const cancelled = list.filter(a => a.status === 'cancelled').length;
  const noShow = list.filter(a => a.status === 'no_show').length;
  const revenue = completed.reduce((s, a) => s + (parseFloat(a.price) || 0), 0);
  const pts = new Set(list.map(a => a.patient_id).filter(Boolean));
  return {
    appointments: list.length, completed: completed.length, cancelled, no_show: noShow,
    upcoming_or_open: list.filter(a => ['booked', 'confirmed', 'in_progress', 'rescheduled'].includes(a.status)).length,
    revenue_completed: round2(revenue), avg_ticket: completed.length ? round2(revenue / completed.length) : 0,
    unique_patients: pts.size,
    cancel_rate_pct: list.length ? round2((cancelled + noShow) * 100 / list.length) : 0,
  };
}

async function toolAppointmentsStats(ctx: Ctx, inp: any) {
  if (!validDate(inp.date_from) || !validDate(inp.date_to)) return { error: 'Χρειάζονται έγκυρες date_from/date_to (YYYY-MM-DD).' };
  let list = await loadAppointments(ctx, inp.date_from, inp.date_to);
  const svcCat = new Map(ctx.services.map(s => [norm(s.name), s.category || 'Χωρίς κατηγορία']));
  const staffName = new Map(ctx.staff.map(s => [s.id, s.full_name]));
  const branchName = new Map(ctx.branches.map(b => [b.id, b.name]));
  if (inp.service_contains) { const q = norm(inp.service_contains); list = list.filter(a => norm(a.service_name).includes(q)); }
  if (inp.service_category) { const q = norm(inp.service_category); list = list.filter(a => norm(svcCat.get(norm(a.service_name)) || '').includes(q)); }
  if (inp.therapist_contains) { const q = norm(inp.therapist_contains); list = list.filter(a => norm(staffName.get(a.therapist_id) || '').includes(q)); }
  if (inp.branch_contains) { const q = norm(inp.branch_contains); list = list.filter(a => norm(branchName.get(a.branch_id) || '').includes(q)); }
  if (Array.isArray(inp.statuses) && inp.statuses.length) list = list.filter(a => inp.statuses.includes(a.status));

  const result: any = { period: { from: inp.date_from, to: inp.date_to }, filters_applied: { service_contains: inp.service_contains || null, service_category: inp.service_category || null, therapist_contains: inp.therapist_contains || null, branch_contains: inp.branch_contains || null, statuses: inp.statuses || null }, ...summarize(list) };

  const gb = inp.group_by || 'none';
  if (gb !== 'none') {
    // Για new_vs_returning χρειάζεται το πρώτο ραντεβού κάθε πελάτη (ιστορικά)
    let firstVisit: Map<string, string> | null = null;
    if (gb === 'new_vs_returning') {
      const ids = [...new Set(list.map(a => a.patient_id).filter(Boolean))];
      firstVisit = new Map();
      for (let i = 0; i < ids.length; i += 300) {
        const chunk = ids.slice(i, i + 300);
        const rows = await fetchAll((a, b) => ctx.sb.from('appointments').select('patient_id,start_time').eq('clinic_id', ctx.cid).eq('is_internal', false).in('patient_id', chunk).not('status', 'in', '(cancelled,no_show)').order('start_time', { ascending: true }).range(a, b));
        for (const r of rows) if (!firstVisit.has(r.patient_id)) firstVisit.set(r.patient_id, r.start_time);
      }
    }
    const keyOf = (a: any): string => {
      const p = athensParts(new Date(a.start_time));
      switch (gb) {
        case 'day': return p.date;
        case 'week': return isoWeek(p.date);
        case 'month': return p.month;
        case 'weekday': return WEEKDAY_GR[p.weekday] || p.weekday;
        case 'hour': return `${String(p.hour).padStart(2, '0')}:00`;
        case 'weekday_hour': return `${WEEKDAY_GR[p.weekday] || p.weekday} ${String(p.hour).padStart(2, '0')}:00`;
        case 'service': return a.service_name || '—';
        case 'service_category': return svcCat.get(norm(a.service_name)) || 'Χωρίς κατηγορία';
        case 'therapist': return staffName.get(a.therapist_id) || 'Χωρίς θεραπευτή';
        case 'status': return a.status;
        case 'branch': return branchName.get(a.branch_id) || 'Χωρίς υποκατάστημα';
        case 'booking_source': return a.from_booking ? 'Online (Booking247)' : 'Χειροκίνητα/τηλέφωνο';
        case 'new_vs_returning': { const fv = firstVisit!.get(a.patient_id); return (fv && fv < a.start_time) ? 'Επαναλαμβανόμενος' : 'Νέος (πρώτη επίσκεψη)'; }
        default: return '—';
      }
    };
    const groups = new Map<string, any[]>();
    for (const a of list) { const k = keyOf(a); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(a); }
    let rows = [...groups.entries()].map(([key, l]) => ({ key, ...summarize(l) }));
    const chrono = ['day', 'week', 'month', 'hour'].includes(gb);
    if (chrono) rows.sort((x, y) => x.key.localeCompare(y.key));
    else if (gb === 'weekday') rows.sort((x, y) => WEEKDAY_ORDER.map(w => WEEKDAY_GR[w]).indexOf(x.key) - WEEKDAY_ORDER.map(w => WEEKDAY_GR[w]).indexOf(y.key));
    else rows.sort((x, y) => y.appointments - x.appointments);
    const limit = Math.min(Math.max(parseInt(inp.limit, 10) || 40, 1), 120);
    result.group_by = gb;
    result.groups_total = rows.length;
    result.rows = rows.slice(0, limit);
    if (gb === 'weekday' || gb === 'hour' || gb === 'weekday_hour') {
      const nz = rows.filter(r => r.appointments > 0);
      if (nz.length) {
        const busiest = [...nz].sort((x, y) => y.appointments - x.appointments)[0];
        const quietest = [...nz].sort((x, y) => x.appointments - y.appointments)[0];
        result.busiest = { key: busiest.key, appointments: busiest.appointments };
        result.quietest = { key: quietest.key, appointments: quietest.appointments };
      }
    }
  }
  return result;
}

async function toolPatientsStats(ctx: Ctx, inp: any) {
  const patients = await fetchAll((a, b) => ctx.sb.from('patients').select('id,status,gdpr_signed,marketing_opt_in,source,city,gender,dob,date_of_birth,is_student,created_at').eq('clinic_id', ctx.cid).range(a, b));
  const appts = await fetchAll((a, b) => ctx.sb.from('appointments').select('patient_id,start_time,status').eq('clinic_id', ctx.cid).eq('is_internal', false).not('status', 'in', '(cancelled,no_show)').lte('start_time', new Date().toISOString()).order('start_time', { ascending: false }).range(a, b), 60000);
  const last = new Map<string, string>();
  for (const a of appts) if (a.patient_id && !last.has(a.patient_id)) last.set(a.patient_id, a.start_time);
  const months = Math.min(Math.max(parseInt(inp.inactive_months, 10) || 6, 1), 60);
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - months);
  const now = new Date();
  const res: any = { total_patients: patients.length };
  if (validDate(inp.date_from) && validDate(inp.date_to)) {
    const f = athensDayStartISO(inp.date_from), t = athensDayEndISO(inp.date_to);
    res.new_patients_in_period = patients.filter(p => p.created_at >= f && p.created_at < t).length;
    res.period = { from: inp.date_from, to: inp.date_to };
  }
  const visited = patients.filter(p => last.has(p.id));
  res.never_visited = patients.length - visited.length;
  res.active_recent = visited.filter(p => new Date(last.get(p.id)!) >= cutoff).length;
  res.inactive = { months, count: visited.filter(p => new Date(last.get(p.id)!) < cutoff).length };
  res.gdpr_signed = patients.filter(p => p.gdpr_signed).length;
  res.marketing_opt_in = patients.filter(p => p.marketing_opt_in).length;
  res.students = patients.filter(p => p.is_student).length;
  const count = (fn: (p: any) => string) => { const m = new Map<string, number>(); for (const p of patients) { const k = fn(p) || '—'; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, n]) => ({ key, patients: n })); };
  res.by_status = count(p => p.status);
  res.by_source = count(p => p.source);
  res.by_city = count(p => p.city);
  res.by_gender = count(p => p.gender);
  const ages = patients.map(p => { const d = p.dob || p.date_of_birth; if (!d) return null; const y = (now.getTime() - new Date(d).getTime()) / (365.25 * 86400000); return y > 0 && y < 110 ? y : null; }).filter((x): x is number => x !== null);
  const bucket = (y: number) => y < 25 ? '<25' : y < 35 ? '25-34' : y < 45 ? '35-44' : y < 55 ? '45-54' : y < 65 ? '55-64' : '65+';
  const ab = new Map<string, number>(); for (const y of ages) ab.set(bucket(y), (ab.get(bucket(y)) || 0) + 1);
  res.age_groups = ['<25', '25-34', '35-44', '45-54', '55-64', '65+'].map(k => ({ key: k, patients: ab.get(k) || 0 }));
  res.age_known_for = ages.length;
  res.avg_age = ages.length ? round2(ages.reduce((s, y) => s + y, 0) / ages.length) : null;
  const in14 = patients.filter(p => { const d = p.dob || p.date_of_birth; if (!d) return false; const b = new Date(d); const next = new Date(now.getFullYear(), b.getMonth(), b.getDate()); if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) next.setFullYear(now.getFullYear() + 1); return (next.getTime() - now.getTime()) <= 14 * 86400000; }).length;
  res.birthdays_next_14_days = in14;
  try {
    const { count } = await ctx.sb.from('google_reviews').select('matched_patient_id', { count: 'exact', head: true }).eq('clinic_id', ctx.cid).in('matching_status', ['auto_matched_high_confidence', 'manually_confirmed']);
    res.with_google_review = count || 0;
  } catch { /* module may be absent */ }
  return res;
}

async function toolRetentionStats(ctx: Ctx, inp: any) {
  if (!validDate(inp.date_from) || !validDate(inp.date_to)) return { error: 'Χρειάζονται έγκυρες date_from/date_to.' };
  const appts = await fetchAll((a, b) => ctx.sb.from('appointments').select('patient_id,start_time').eq('clinic_id', ctx.cid).eq('is_internal', false).not('status', 'in', '(cancelled,no_show)').lte('start_time', new Date().toISOString()).order('start_time', { ascending: true }).range(a, b), 60000);
  const byPatient = new Map<string, string[]>();
  for (const a of appts) { if (!a.patient_id) continue; if (!byPatient.has(a.patient_id)) byPatient.set(a.patient_id, []); byPatient.get(a.patient_id)!.push(a.start_time); }
  const f = athensDayStartISO(inp.date_from), t = athensDayEndISO(inp.date_to);
  const cohort = [...byPatient.entries()].filter(([, times]) => times[0] >= f && times[0] < t);
  const returnedWithin = (days: number) => cohort.filter(([, times]) => times.some((x, i) => i > 0 && (new Date(x).getTime() - new Date(times[0]).getTime()) <= days * 86400000)).length;
  const inPeriod = appts.filter(a => a.start_time >= f && a.start_time < t);
  const returningInPeriod = inPeriod.filter(a => { const times = byPatient.get(a.patient_id) || []; return times[0] < a.start_time; }).length;
  return {
    period: { from: inp.date_from, to: inp.date_to },
    new_patients_first_visit_in_period: cohort.length,
    returned_within_90_days: returnedWithin(90), returned_within_180_days: returnedWithin(180), returned_within_365_days: returnedWithin(365),
    return_rate_90_pct: cohort.length ? round2(returnedWithin(90) * 100 / cohort.length) : null,
    return_rate_180_pct: cohort.length ? round2(returnedWithin(180) * 100 / cohort.length) : null,
    avg_visits_per_cohort_patient: cohort.length ? round2(cohort.reduce((s, [, times]) => s + times.length, 0) / cohort.length) : null,
    appointments_in_period: inPeriod.length,
    appointments_from_returning_patients_pct: inPeriod.length ? round2(returningInPeriod * 100 / inPeriod.length) : null,
    note: 'Η κοόρτη «νέοι» ορίζεται από το πρώτο μη-ακυρωμένο ραντεβού στο διάστημα. Πρόσφατες κοόρτες δεν είχαν ακόμα χρόνο να επιστρέψουν.',
  };
}

async function toolProductSales(ctx: Ctx, inp: any) {
  if (!validDate(inp.date_from) || !validDate(inp.date_to)) return { error: 'Χρειάζονται έγκυρες date_from/date_to.' };
  const rows = await fetchAll((a, b) => ctx.sb.from('product_sales').select('product_name,quantity,amount,payment_method,created_at').eq('clinic_id', ctx.cid).gte('created_at', athensDayStartISO(inp.date_from)).lt('created_at', athensDayEndISO(inp.date_to)).range(a, b));
  const total = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const res: any = { period: { from: inp.date_from, to: inp.date_to }, sales: rows.length, units: round2(rows.reduce((s, r) => s + (parseFloat(r.quantity) || 1), 0)), revenue: round2(total), avg_sale: rows.length ? round2(total / rows.length) : 0 };
  const gb = inp.group_by || 'none';
  if (gb !== 'none') {
    const m = new Map<string, { sales: number; revenue: number; units: number }>();
    for (const r of rows) {
      const k = gb === 'product' ? (r.product_name || '—') : gb === 'month' ? athensParts(new Date(r.created_at)).month : (r.payment_method || '—');
      const g = m.get(k) || { sales: 0, revenue: 0, units: 0 }; g.sales++; g.revenue += parseFloat(r.amount) || 0; g.units += parseFloat(r.quantity) || 1; m.set(k, g);
    }
    res.group_by = gb;
    res.rows = [...m.entries()].map(([key, g]) => ({ key, sales: g.sales, units: round2(g.units), revenue: round2(g.revenue) })).sort((x, y) => gb === 'month' ? x.key.localeCompare(y.key) : y.revenue - x.revenue).slice(0, 40);
  }
  return res;
}

async function toolPackages(ctx: Ctx, inp: any) {
  if (!validDate(inp.date_from) || !validDate(inp.date_to)) return { error: 'Χρειάζονται έγκυρες date_from/date_to.' };
  const laser = await fetchAll((a, b) => ctx.sb.from('patient_packages').select('name,service_name,total_sessions,price,purchased_at').eq('clinic_id', ctx.cid).gte('purchased_at', inp.date_from).lte('purchased_at', inp.date_to).range(a, b));
  let general: any[] = [];
  try { general = await fetchAll((a, b) => ctx.sb.from('general_packages').select('name,service_names,total_sessions,price,purchased_at').eq('clinic_id', ctx.cid).gte('purchased_at', inp.date_from).lte('purchased_at', inp.date_to).range(a, b)); } catch { general = []; }
  const all = [...laser.map(p => ({ ...p, kind: 'laser' })), ...general.map(p => ({ ...p, kind: 'general' }))];
  const rev = (l: any[]) => round2(l.reduce((s, p) => s + (parseFloat(p.price) || 0), 0));
  const byName = new Map<string, { count: number; revenue: number }>();
  for (const p of all) { const k = p.name || p.service_name || '—'; const g = byName.get(k) || { count: 0, revenue: 0 }; g.count++; g.revenue += parseFloat(p.price) || 0; byName.set(k, g); }
  const byMonth = new Map<string, { count: number; revenue: number }>();
  for (const p of all) { const k = String(p.purchased_at || '').slice(0, 7); const g = byMonth.get(k) || { count: 0, revenue: 0 }; g.count++; g.revenue += parseFloat(p.price) || 0; byMonth.set(k, g); }
  return {
    period: { from: inp.date_from, to: inp.date_to },
    packages_sold: all.length, revenue: rev(all), laser_packages: laser.length, laser_revenue: rev(laser), general_packages: general.length, general_revenue: rev(general),
    by_name: [...byName.entries()].map(([key, g]) => ({ key, count: g.count, revenue: round2(g.revenue) })).sort((x, y) => y.revenue - x.revenue).slice(0, 25),
    by_month: [...byMonth.entries()].map(([key, g]) => ({ key, count: g.count, revenue: round2(g.revenue) })).sort((x, y) => x.key.localeCompare(y.key)),
  };
}

async function toolCommunications(ctx: Ctx, inp: any) {
  if (!validDate(inp.date_from) || !validDate(inp.date_to)) return { error: 'Χρειάζονται έγκυρες date_from/date_to.' };
  const rows = await fetchAll((a, b) => ctx.sb.from('communication_log').select('automation_type,channel,status,created_at').eq('clinic_id', ctx.cid).gte('created_at', athensDayStartISO(inp.date_from)).lt('created_at', athensDayEndISO(inp.date_to)).range(a, b), 60000);
  const gb = inp.group_by || 'type';
  const m = new Map<string, { total: number; sent: number }>();
  for (const r of rows) {
    const k = gb === 'type' ? r.automation_type : gb === 'channel' ? (r.channel || '—') : gb === 'status' ? (r.status || '—') : gb === 'month' ? athensParts(new Date(r.created_at)).month : `${r.automation_type} / ${r.channel || '—'}`;
    const g = m.get(k || '—') || { total: 0, sent: 0 }; g.total++; if (r.status === 'sent') g.sent++; m.set(k || '—', g);
  }
  return { period: { from: inp.date_from, to: inp.date_to }, total_log_entries: rows.length, sent: rows.filter(r => r.status === 'sent').length, group_by: gb, rows: [...m.entries()].map(([key, g]) => ({ key, total: g.total, sent: g.sent })).sort((x, y) => gb === 'month' ? x.key.localeCompare(y.key) : y.total - x.total).slice(0, 40), note: 'status=sent σημαίνει στάλθηκε· άλλες τιμές (no_set, no_email, skipped_…) σημαίνουν ότι δεν στάλθηκε και γιατί.' };
}

async function toolReviews(ctx: Ctx) {
  const rows = await fetchAll((a, b) => ctx.sb.from('google_reviews').select('star_rating,review_create_time,matching_status').eq('clinic_id', ctx.cid).is('review_deleted_at', null).range(a, b));
  const rated = rows.filter(r => r.star_rating);
  const now = Date.now();
  const byStar: Record<string, number> = {}; for (const r of rated) byStar[r.star_rating] = (byStar[r.star_rating] || 0) + 1;
  const byMonth = new Map<string, number>(); for (const r of rows) { if (!r.review_create_time) continue; const k = athensParts(new Date(r.review_create_time)).month; byMonth.set(k, (byMonth.get(k) || 0) + 1); }
  return {
    total_reviews: rows.length, avg_rating: rated.length ? round2(rated.reduce((s, r) => s + r.star_rating, 0) / rated.length) : null,
    by_stars: byStar,
    last_30_days: rows.filter(r => r.review_create_time && now - new Date(r.review_create_time).getTime() <= 30 * 86400000).length,
    last_90_days: rows.filter(r => r.review_create_time && now - new Date(r.review_create_time).getTime() <= 90 * 86400000).length,
    linked_to_patient: rows.filter(r => ['auto_matched_high_confidence', 'manually_confirmed'].includes(r.matching_status)).length,
    pending_review: rows.filter(r => r.matching_status === 'needs_review').length,
    by_month: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-24).map(([key, n]) => ({ key, reviews: n })),
  };
}

async function runTool(ctx: Ctx, name: string, input: any) {
  switch (name) {
    case 'appointments_stats': return toolAppointmentsStats(ctx, input || {});
    case 'patients_stats': return toolPatientsStats(ctx, input || {});
    case 'retention_stats': return toolRetentionStats(ctx, input || {});
    case 'product_sales_stats': return toolProductSales(ctx, input || {});
    case 'packages_stats': return toolPackages(ctx, input || {});
    case 'communications_stats': return toolCommunications(ctx, input || {});
    case 'reviews_stats': return toolReviews(ctx);
    default: return { error: 'Άγνωστο εργαλείο' };
  }
}

function buildSystemPrompt(clinicName: string, ctx: Ctx, role: string) {
  const today = athensParts(new Date());
  const svc = ctx.services.slice(0, 150).map(s => `${s.name}${s.category ? ` [${s.category}]` : ''}`).join('; ');
  const staff = ctx.staff.map(s => `${s.full_name} (${s.role})`).join('; ');
  const branches = ctx.branches.map(b => b.name).join('; ');
  return `Είσαι ο αναλυτικός βοηθός του CRM της κλινικής «${clinicName}» (medi360 CRM). Απαντάς σε ερωτήσεις του ιδιοκτήτη/διαχειριστή για τη λειτουργία της κλινικής (θεραπείες, ραντεβού, έσοδα, πελάτες, πωλήσεις, μηνύματα, κριτικές) ΑΠΟΚΛΕΙΣΤΙΚΑ με βάση τα εργαλεία που έχεις. Ποτέ μη μαντεύεις αριθμούς.

Σήμερα: ${today.date} (${WEEKDAY_GR[today.weekday] || today.weekday}), ώρα Ελλάδας. Ρόλος χρήστη: ${role}.
Υπηρεσίες της κλινικής: ${svc || '—'}
Προσωπικό: ${staff || '—'}
Υποκαταστήματα: ${branches || 'κανένα'}

Κανόνες:
1. Πάντα στα ελληνικά, σύντομα και συγκεκριμένα. Πρώτα η απάντηση (ο αριθμός), μετά η ανάλυση. Για αναλύσεις χρησιμοποίησε πίνακα Markdown (μέγιστο ~15 γραμμές· αν είναι περισσότερες, δείξε τις κορυφαίες και πες πόσες υπάρχουν).
2. Δήλωνε πάντα το διάστημα που χρησιμοποίησες (π.χ. «1–24 Σεπτεμβρίου 2026»). Αν ο χρήστης δεν έδωσε διάστημα, διάλεξε το πιο λογικό (π.χ. «αυτόν τον μήνα» = από την 1η του μήνα έως σήμερα, «τελευταίους 3 μήνες» = 90 ημέρες έως σήμερα) και πες το. Μη ρωτάς διευκρινίσεις εκτός αν η ερώτηση είναι πραγματικά διφορούμενη.
3. Ορισμοί: «έγιναν» = ολοκληρωμένα ραντεβού (status completed)· «κλείστηκαν» = όλα τα ραντεβού· έσοδα υπηρεσιών = τιμή ολοκληρωμένων ραντεβού· έσοδα προϊόντων = product_sales_stats· πακέτα = packages_stats. Αν ζητηθούν «συνολικά έσοδα», άθροισε υπηρεσίες + προϊόντα + πακέτα και δείξε την ανάλυση. Τα εσωτερικά ραντεβού (μπλοκαρίσματα) εξαιρούνται ήδη.
4. Για «ποια μέρα/ώρα είναι η πιο αδύναμη/δυνατή» χρησιμοποίησε group_by weekday / hour / weekday_hour σε επαρκές διάστημα (τουλάχιστον 8–12 εβδομάδες) και πες ποιο διάστημα χρησιμοποίησες.
5. Για συγκρίσεις («σε σχέση με πέρυσι/τον προηγούμενο μήνα») κάλεσε το ίδιο εργαλείο δύο φορές και δώσε τη διαφορά και το ποσοστό μεταβολής.
6. Ονόματα υπηρεσιών: αντιστοίχισε τη λέξη του χρήστη με τη λίστα υπηρεσιών (π.χ. «υδροδερμοαπόξεση» ≈ «Hydrafacial»). Αν η αναζήτηση επιστρέψει 0, δοκίμασε ευρύτερο φίλτρο ή την κατηγορία και πες τι έψαξες.
7. Ποτέ μη ζητάς ούτε να εμφανίζεις ονόματα, τηλέφωνα ή στοιχεία μεμονωμένων πελατών — τα εργαλεία δίνουν μόνο αθροίσματα. Αν ρωτήσουν για συγκεκριμένο πελάτη, πες ευγενικά ότι αυτό γίνεται από την αναζήτηση/καρτέλα του CRM.
8. Όταν ένα νούμερο είναι ασυνήθιστο ή τα δεδομένα λίγα, πες το (π.χ. λίγα ραντεβού με τιμή καταχωρημένη → τα έσοδα υποεκτιμώνται).
9. Κλείσε με μία πρόταση πρακτικού συμπεράσματος ή πρότασης όταν έχει νόημα, όχι γενικότητες.`;
}

async function callClaude(apiKey: string, payload: unknown) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const d = await r.json();
  if (d.error) throw new Error('AI error: ' + (d.error.message || JSON.stringify(d.error)));
  return d;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: 'Invalid JSON' }, 400);

    // ── Ταυτοποίηση ──
    let sb: any, role = 'clinic_admin', cid: string | null = null;
    const cronSecret = Deno.env.get('BIRTHDAY_CRON_SECRET');
    if (cronSecret && req.headers.get('x-cron-secret') === cronSecret) {
      sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      cid = String(body.clinic_id || ''); role = 'super_admin';
      if (!cid) return json({ error: 'clinic_id required' }, 400);
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);
      sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
      const { data: { user }, error: userErr } = await sb.auth.getUser();
      if (userErr || !user) return json({ error: 'Not authenticated' }, 401);
      const { data: profile } = await sb.from('profiles').select('role,clinic_id').eq('id', user.id).single();
      if (!profile) return json({ error: 'Profile not found' }, 403);
      role = profile.role;
      if (!['super_admin', 'clinic_admin'].includes(role)) return json({ error: 'Ο βοηθός στατιστικών είναι διαθέσιμος μόνο σε διαχειριστές.' }, 403);
      cid = (role === 'super_admin' && body.clinic_id) ? String(body.clinic_id) : profile.clinic_id;
      if (!cid) return json({ error: 'Δεν βρέθηκε κλινική' }, 400);
    }

    // ── Δεδομένα αναφοράς (υπηρεσίες, προσωπικό, υποκαταστήματα) ──
    const [{ data: clinic }, { data: services }, { data: staff }, { data: branches }] = await Promise.all([
      sb.from('clinics').select('name').eq('id', cid).maybeSingle(),
      sb.from('services').select('name,category').eq('clinic_id', cid).order('name'),
      sb.from('profiles').select('id,full_name,role').eq('clinic_id', cid),
      sb.from('clinic_branches').select('id,name').eq('clinic_id', cid),
    ]);
    if (!clinic) return json({ error: 'Χωρίς πρόσβαση στην κλινική' }, 403);
    const ctx: Ctx = { sb, cid, services: services || [], staff: staff || [], branches: branches || [] };

    // ── Μηνύματα συνομιλίας (μόνο κείμενο από τον client, με όρια) ──
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    const messages: any[] = incoming
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-16)
      .map((m: any) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'Λείπει η ερώτηση' }, 400);

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')!;
    const system = buildSystemPrompt(clinic.name || 'Κλινική', ctx, role);
    const toolCalls: { name: string; input: any; ms: number }[] = [];
    let reply = '';
    let usage: any = null;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const resp = await callClaude(apiKey, { model: MODEL, max_tokens: 1800, system, tools: TOOLS, messages });
      usage = resp.usage || usage;
      const content = resp.content || [];
      const toolUses = content.filter((c: any) => c.type === 'tool_use');
      const texts = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
      if (resp.stop_reason !== 'tool_use' || !toolUses.length) { reply = texts; break; }
      messages.push({ role: 'assistant', content });
      const results: any[] = [];
      for (const tu of toolUses) {
        const t0 = Date.now();
        let out: any;
        try { out = await runTool(ctx, tu.name, tu.input); } catch (e) { out = { error: e instanceof Error ? e.message : String(e) }; }
        toolCalls.push({ name: tu.name, input: tu.input, ms: Date.now() - t0 });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 60000) });
      }
      messages.push({ role: 'user', content: results });
      if (round === MAX_TOOL_ROUNDS) reply = texts || 'Χρειάστηκαν πάρα πολλά βήματα — δοκίμασε πιο συγκεκριμένη ερώτηση.';
    }

    return json({ reply, tool_calls: toolCalls, usage, model: MODEL });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});
