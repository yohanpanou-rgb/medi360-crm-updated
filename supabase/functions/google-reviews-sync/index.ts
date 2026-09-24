// Supabase Edge Function — Google Reviews sync, Φάση 1 (email-based).
// Διαβάζει τα αυτόματα email ειδοποίησης του Google Business Profile
// (businessprofile-noreply@google.com) μέσα από το ίδιο mailbox/refresh
// token που ήδη χρησιμοποιεί το gmail-auto-sync (server-side OAuth, καμία
// νέα ρύθμιση) και τα αποθηκεύει στον πίνακα google_reviews με source='email'.
// Καμία αυτόματη εγγραφή στον φάκελο πελάτη χωρίς HIGH confidence match —
// όλα τα υπόλοιπα πηγαίνουν σε needs_review για χειροκίνητη επιβεβαίωση.
//
// Σχεδιασμός: Claude Docs "Medi360 × Google Reviews — Έρευνα & Σχεδιασμός".
// Φάση 2 (μελλοντική, μετά έγκριση API): accounts.locations.reviews.list.
//
// Λειτουργίες (body.mode ή ?mode=):
//   sync     (default) — νέα review emails από το Gmail → google_reviews
//   rematch  — ξανατρέχει ΜΟΝΟ το matching engine στις υπάρχουσες κριτικές
//              με status unmatched / needs_review (χωρίς Gmail). Χρήσιμο μετά
//              από βελτίωση του engine ή προσθήκη πελατών.
//   both     — και τα δύο
//
// Ασφάλεια: x-cron-secret (ίδιο με τα υπόλοιπα automations: BIRTHDAY_CRON_SECRET)
// για το pg_cron, ή Authorization Bearer JWT χρήστη με ρόλο super_admin /
// clinic_admin (για τα κουμπιά «Συγχρονισμός τώρα» / «Ξανά ταύτιση» στο CRM).
//
// Scheduled via pg_cron (job "google-reviews-sync-hourly").
// Χρησιμοποιεί τα ΗΔΗ υπάρχοντα secrets GOOGLE_CLIENT_ID/CLIENT_SECRET/
// REFRESH_TOKEN (ίδια με gmail-auto-sync). SUPABASE_URL/SERVICE_ROLE_KEY
// injected αυτόματα. Redeploy μετά από αλλαγή:
//   supabase functions deploy google-reviews-sync

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, x-cron-secret'}
const SYNCED_LABEL = 'medi360-reviews-synced'

// ── Παράθυρα του matching engine (σε ημέρες, σε σχέση με την ημερομηνία της κριτικής) ──
const EXACT_APPT_WINDOW_DAYS = 180      // ακριβές ελληνικό όνομα + ραντεβού μέσα σε 180 μέρες πριν → HIGH
const TRANSLIT_APPT_WINDOW_DAYS = 30    // ίδιο όνομα με μεταγραφή (λατινικά) + ραντεβού μέσα σε 30 μέρες → HIGH
const FIRSTNAME_APPT_WINDOW_DAYS = 30   // μόνο μικρό όνομα: υποψήφιοι ΜΟΝΟ όσοι είχαν ραντεβού μέσα σε 30 μέρες
const REVIEW_REQUEST_WINDOW_DAYS = 14   // «έλαβε αίτημα αξιολόγησης» τις 14 μέρες πριν την κριτική
const APPT_LOOKBACK_DAYS = 200          // πόσο πίσω ψάχνουμε το «τελευταίο ραντεβού πριν την κριτική»
const MAX_CANDIDATES_STORED = 8

async function getToken() {
  const r = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:Deno.env.get('GOOGLE_CLIENT_ID')!,client_secret:Deno.env.get('GOOGLE_CLIENT_SECRET')!,refresh_token:Deno.env.get('GOOGLE_REFRESH_TOKEN')!,grant_type:'refresh_token'})})
  const d = await r.json()
  if(!d.access_token) throw new Error('Token failed: '+JSON.stringify(d))
  return d.access_token
}

async function gmailSearch(token:string,q:string,max=100) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max}`,{headers:{Authorization:'Bearer '+token}})
  const d = await r.json()
  return (d.messages||[]) as {id:string}[]
}

async function gmailGetFull(token:string,id:string) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,{headers:{Authorization:'Bearer '+token}})
  return r.json()
}

function decodeB64(data:string): string {
  data = data.replace(/-/g,'+').replace(/_/g,'/')
  try { return decodeURIComponent(escape(atob(data))) } catch { return atob(data) }
}

// Επιστρέφει το HTML σώμα (το email της Google είναι HTML-only, χωρίς
// text/plain part σε πραγματικά δείγματα).
function extractHtml(payload:any): string {
  if (!payload) return ''
  if (payload.mimeType==='text/html' && payload.body?.data) return decodeB64(payload.body.data)
  if (payload.parts) { for (const p of payload.parts) { const t=extractHtml(p); if (t) return t } }
  if (payload.mimeType!=='text/plain' && payload.body?.data) return decodeB64(payload.body.data)
  return ''
}

// Μετατρέπει HTML σε γραμμές κειμένου, διατηρώντας τα line breaks των block
// στοιχείων — απαραίτητο για τη θεσιακή λογική στο parseReviewEmail().
function htmlToLines(html:string): string[] {
  const t = html
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/(p|div|td|tr|table|h[1-6]|li)>/gi,'\n')
    .replace(/<[^>]+>/g,'')
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>')
    .replace(/&#39;/gi,"'")
    .replace(/&quot;/gi,'"')
  return t.split('\n').map(l=>l.trim()).filter(Boolean)
}

// Το review permalink (το ίδιο link πίσω από "Ανάγνωση κριτικής" ΚΑΙ
// "Απαντήστε στην κριτική") περιέχει ένα σταθερό, μοναδικό ανά-review token
// και το fid (σταθερό ανά-τοποθεσία αναγνωριστικό) — εξάγονται απευθείας
// από το URL, χωρίς να χρειάζεται το επίσημο API.
function extractReviewToken(html:string): {reviewToken:string|null, locationFid:string|null} {
  const m = html.match(/\/reviews\/([A-Za-z0-9_=+-]+)\?fid=(\d+)/)
  if (!m) return {reviewToken:null, locationFid:null}
  return {reviewToken:m[1], locationFid:m[2]}
}

// Δομή του email (επιβεβαιωμένη σε πραγματικά δείγματα από businessprofile-noreply@google.com):
//   "Μπράβο, λάβατε μια νέα κριτική N αστεριών"   ← αστέρια
//   "Ανάγνωση κριτικής"
//   "<Όνομα Επώνυμο reviewer>"                     ← πρώτη μη-URL γραμμή μετά
//   ["(Translated by Google)"] <κείμενο κριτικής...>
//   "Απαντήστε στην κριτική"
function parseReviewEmail(lines:string[]): {stars:number|null, reviewerName:string|null, text:string|null, isTranslated:boolean} {
  let stars: number|null = null
  for (const l of lines) {
    const m = l.match(/(\d)\s*αστ/i)
    if (m) { stars = parseInt(m[1],10); break }
  }
  const readIdx = lines.findIndex(l => /^Ανάγνωση κριτικής/i.test(l))
  const replyIdx = lines.findIndex(l => /^Απαντήστε στην κριτική/i.test(l))
  let reviewerName: string|null = null
  let text: string|null = null
  let isTranslated = false
  if (readIdx >= 0) {
    for (let i = readIdx+1; i < lines.length; i++) {
      if (/^https?:\/\//i.test(lines[i])) continue
      reviewerName = lines[i]
      const endIdx = replyIdx > i ? replyIdx : lines.length
      const body = lines.slice(i+1, endIdx).filter(l => !/^https?:\/\//i.test(l))
      isTranslated = body[0] ? /^\(Translated by Google\)/i.test(body[0]) : false
      text = body.join(' ').trim() || null
      break
    }
  }
  return { stars, reviewerName, text, isTranslated }
}

// Ίδια σύμβαση με το normalizePatientName του index.html / gmail-auto-sync.
function normalizePatientName(s:string): string {
  return (s||'')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/́/g, '')
    .normalize('NFC')
}

// Το όνομα reviewer έρχεται σαν "Όνομα Επώνυμο" — δοκιμάζουμε και τις δύο
// σειρές έναντι patients.full_name, ώστε να μην χάνουμε matches επειδή το
// CRM αποθηκεύει "Επώνυμο Όνομα".
function nameVariants(name:string): string[] {
  const norm = normalizePatientName(name)
  const parts = norm.split(/\s+/).filter(Boolean)
  const variants = new Set<string>([norm])
  if (parts.length === 2) variants.add(parts[1]+' '+parts[0])
  return [...variants]
}

// ── Φωνητικός «σκελετός» ονόματος: ελληνικά ΚΑΙ λατινικά καταλήγουν στην ίδια
// απλοποιημένη λατινική μορφή, ώστε "Μαρία Παπαδοπούλου" ≈ "Maria Papadopoulou",
// "Ειρήνη" ≈ "Eirini" ≈ "Irini", "Χαρά" ≈ "Chara" ≈ "Hara". Η ίδια λογική
// υπάρχει και στο index.html (reviewSkeleton) για τους «πιθανούς πελάτες».
function skeleton(t:string): string {
  let s = (t||'').toLowerCase()
  s = s.replace(/[άἀἁὰᾶ]/g,'α').replace(/[έἐἑὲ]/g,'ε').replace(/[ήἠἡὴῆ]/g,'η').replace(/[ίϊΐἰἱὶῖ]/g,'ι').replace(/[όὀὁὸ]/g,'ο').replace(/[ύϋΰὐὑὺῦ]/g,'υ').replace(/[ώὠὡὼῶ]/g,'ω')
  s = s.replace(/ου/g,'u').replace(/ει/g,'i').replace(/οι/g,'i').replace(/αι/g,'e').replace(/ευ/g,'ev').replace(/αυ/g,'av')
  s = s.replace(/μπ/g,'b').replace(/ντ/g,'d').replace(/γκ/g,'g').replace(/γγ/g,'g')
  s = s.replace(/θ/g,'th').replace(/ψ/g,'ps').replace(/ξ/g,'ks').replace(/χ/g,'h')
  const map: Record<string,string> = {α:'a',β:'v',γ:'g',δ:'d',ε:'e',ζ:'z',η:'i',ι:'i',κ:'k',λ:'l',μ:'m',ν:'n',ο:'o',π:'p',ρ:'r',σ:'s',ς:'s',τ:'t',υ:'i',φ:'f',ω:'o'}
  s = s.replace(/[α-ω]/g, ch => map[ch] || ch)
  // λατινική κανονικοποίηση (ισχύει και για ό,τι προέκυψε από τα ελληνικά)
  s = s.replace(/ou/g,'u').replace(/ch/g,'h').replace(/kh/g,'h').replace(/ph/g,'f').replace(/th/g,'8').replace(/ee/g,'i').replace(/ck/g,'k')
  s = s.replace(/ei/g,'i').replace(/oi/g,'i').replace(/ai/g,'e').replace(/ef/g,'ev').replace(/af/g,'av')
  s = s.replace(/nt/g,'d').replace(/mp/g,'b').replace(/gk/g,'g').replace(/ng/g,'g').replace(/j/g,'gi')
  s = s.replace(/c/g,'k').replace(/y/g,'i').replace(/w/g,'o').replace(/b/g,'v').replace(/x/g,'ks').replace(/8/g,'th')
  s = s.replace(/([a-z])\1/g,'$1')
  s = s.replace(/[^a-z ]/g,' ').replace(/\s+/g,' ').trim()
  return s
}

type PatientLite = {id:string, full_name:string}
type Candidate = {patient_id:string, kind:'exact'|'translit'|'first_initial'|'first_only', days_since_appt:number|null, got_review_request:boolean}
type MatchResult = {status:string, confidence:string|null, matched_patient_id:string|null, signals:Record<string,unknown>}

// Ευρετήρια πελατολογίου — χτίζονται μία φορά ανά τρέξιμο.
class PatientIndex {
  exact = new Map<string, PatientLite[]>()
  skel = new Map<string, PatientLite[]>()        // πλήρης σκελετός (και οι δύο σειρές λέξεων)
  byWord = new Map<string, PatientLite[]>()      // κάθε λέξη σκελετού → πελάτες
  skelWords = new Map<string, string[]>()        // patient id → λέξεις σκελετού
  constructor(rows: PatientLite[]) {
    for (const p of rows) {
      for (const v of nameVariants(p.full_name||'')) this.push(this.exact, v, p)
      const words = skeleton(p.full_name||'').split(' ').filter(Boolean)
      this.skelWords.set(p.id, words)
      if (words.length) {
        this.push(this.skel, words.join(' '), p)
        if (words.length === 2) this.push(this.skel, words[1]+' '+words[0], p)
        for (const w of new Set(words)) this.push(this.byWord, w, p)
      }
    }
  }
  private push(m: Map<string, PatientLite[]>, k: string, p: PatientLite) { if (!m.has(k)) m.set(k, []); m.get(k)!.push(p) }
}

function uniq(list: PatientLite[]): PatientLite[] { return [...new Map(list.map(c=>[c.id,c])).values()] }

// Βρίσκει υποψήφιους πελάτες για ένα όνομα reviewer, κατά σειρά αξιοπιστίας.
function findCandidates(idx: PatientIndex, reviewerName: string): {kind: Candidate['kind'], list: PatientLite[]} {
  // 1. Ακριβές ελληνικό όνομα (όπως πριν)
  let list: PatientLite[] = []
  for (const v of nameVariants(reviewerName)) { const c = idx.exact.get(v); if (c) list = list.concat(c) }
  if (list.length) return {kind:'exact', list: uniq(list)}
  const words = skeleton(reviewerName).split(' ').filter(Boolean)
  if (!words.length) return {kind:'exact', list: []}
  // 2. Ίδιο πλήρες όνομα με μεταγραφή (π.χ. λατινικά)
  if (words.length >= 2) {
    const full = idx.skel.get(words.join(' ')) || []
    if (full.length) return {kind:'translit', list: uniq(full)}
    // Περισσότερες από 2 λέξεις (διπλά ονόματα): όλες οι λέξεις του reviewer μέσα στο όνομα πελάτη
    if (words.length > 2) {
      const pool = idx.byWord.get(words[0]) || []
      const sub = pool.filter(p => { const pw = idx.skelWords.get(p.id)||[]; return words.every(w => pw.includes(w)) })
      if (sub.length) return {kind:'translit', list: uniq(sub)}
    }
  }
  // 3. Μικρό όνομα + αρχικό επωνύμου ("Maria P." / "Μαρία Π")
  if (words.length === 2 && words[1].length === 1) {
    const pool = idx.byWord.get(words[0]) || []
    const sub = pool.filter(p => (idx.skelWords.get(p.id)||[]).some(w => w !== words[0] && w.startsWith(words[1])))
    if (sub.length) return {kind:'first_initial', list: uniq(sub)}
  }
  // 4. Μόνο μικρό όνομα (ή όνομα + κάτι που δεν ταιριάζει, π.χ. username) — φιλτράρεται
  //    αργότερα με πρόσφατο ραντεβού, αλλιώς είναι δεκάδες.
  const pool = idx.byWord.get(words[0]) || []
  return {kind:'first_only', list: uniq(pool)}
}

async function enrichCandidates(sb: any, cid: string, kind: Candidate['kind'], list: PatientLite[], reviewDateIso: string): Promise<Candidate[]> {
  if (!list.length) return []
  const reviewMs = new Date(reviewDateIso).getTime()
  const upper = new Date(reviewMs + 86400*1000).toISOString()
  const lookback = new Date(reviewMs - (kind==='first_only' ? FIRSTNAME_APPT_WINDOW_DAYS : APPT_LOOKBACK_DAYS)*86400*1000).toISOString()
  const ids = list.map(p=>p.id)
  const {data:appts} = await sb.from('appointments').select('patient_id,start_time').eq('clinic_id',cid).in('patient_id',ids)
    .eq('is_internal',false).not('status','in','(cancelled,no_show)').lte('start_time',upper).gte('start_time',lookback).order('start_time',{ascending:false}).limit(2000)
  const nearest = new Map<string, number>()
  for (const a of (appts||[])) {
    if (nearest.has(a.patient_id)) continue
    nearest.set(a.patient_id, Math.round((reviewMs - new Date(a.start_time).getTime())/86400000))
  }
  const rrLower = new Date(reviewMs - REVIEW_REQUEST_WINDOW_DAYS*86400*1000).toISOString()
  const {data:rrs} = await sb.from('communication_log').select('patient_id').eq('clinic_id',cid).in('patient_id',ids)
    .eq('automation_type','review_request').eq('status','sent').gte('created_at',rrLower).lte('created_at',upper).limit(500)
  const gotRR = new Set((rrs||[]).map((r:any)=>r.patient_id))
  let out: Candidate[] = list.map(p => ({patient_id:p.id, kind, days_since_appt: nearest.has(p.id) ? nearest.get(p.id)! : null, got_review_request: gotRR.has(p.id)}))
  // Μόνο-μικρό-όνομα: κρατάμε μόνο όσους έχουν πρόσφατο ραντεβού ή έλαβαν αίτημα αξιολόγησης
  if (kind === 'first_only') out = out.filter(c => c.days_since_appt !== null || c.got_review_request)
  out.sort((a,b) => (a.days_since_appt ?? 9999) - (b.days_since_appt ?? 9999) || (b.got_review_request?1:0) - (a.got_review_request?1:0))
  return out
}

// ── Matching engine v2 (ενότητα C του σχεδιασμού + μεταγραφή/ημερομηνίες) ──
// HIGH μόνο όταν: ένας και μοναδικός υποψήφιος με ΠΛΗΡΕΣ όνομα (ακριβές ή με
// μεταγραφή) ΚΑΙ ραντεβού μέσα στο αντίστοιχο παράθυρο πριν την κριτική.
// Όλα τα υπόλοιπα με υποψήφιους → needs_review (με ταξινομημένη λίστα).
async function matchReview(sb: any, cid: string, idx: PatientIndex, reviewerName: string, reviewDateIso: string): Promise<MatchResult> {
  const {kind, list} = findCandidates(idx, reviewerName)
  const cands = await enrichCandidates(sb, cid, kind, list, reviewDateIso)
  const signals: Record<string,unknown> = {
    engine: 2,
    name_variants: nameVariants(reviewerName),
    skeleton: skeleton(reviewerName),
    best_kind: cands.length ? kind : null,
    candidate_count: cands.length,
    candidates: cands.slice(0, MAX_CANDIDATES_STORED),
  }
  if (!cands.length) return {status:'unmatched', confidence:'low', matched_patient_id:null, signals}
  if (cands.length === 1 && (kind === 'exact' || kind === 'translit')) {
    const c = cands[0]
    const window = kind === 'exact' ? EXACT_APPT_WINDOW_DAYS : TRANSLIT_APPT_WINDOW_DAYS
    const recent = c.days_since_appt !== null && c.days_since_appt >= -1 && c.days_since_appt <= window
    signals.has_recent_appt = recent
    if (recent) return {status:'auto_matched_high_confidence', confidence:'high', matched_patient_id:c.patient_id, signals}
  }
  return {status:'needs_review', confidence:'medium', matched_patient_id:null, signals}
}

async function getOrCreateLabelId(token:string): Promise<string> {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels',{headers:{Authorization:'Bearer '+token}})
  const d = await r.json()
  const existing = (d.labels||[]).find((l:any)=>l.name.toLowerCase()===SYNCED_LABEL.toLowerCase())
  if (existing) return existing.id
  const cr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels',{
    method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({name:SYNCED_LABEL,labelListVisibility:'labelShow',messageListVisibility:'show'})
  })
  const cd = await cr.json()
  if (!cd.id) throw new Error('Label creation failed: '+JSON.stringify(cd))
  return cd.id
}

async function markSynced(token:string, id:string, labelId:string) {
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`,{
    method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({addLabelIds:[labelId]})
  })
}

// Έλεγχος πρόσβασης: cron secret Ή συνδεδεμένος admin του CRM.
async function authorize(req: Request, sb: any): Promise<{ok:boolean, reason?:string}> {
  const secret = Deno.env.get('BIRTHDAY_CRON_SECRET')
  if (secret && req.headers.get('x-cron-secret') === secret) return {ok:true}
  const auth = req.headers.get('authorization') || ''
  const jwt = auth.replace(/^Bearer\s+/i,'')
  if (!jwt) return {ok:false, reason:'missing credentials'}
  const {data:u} = await sb.auth.getUser(jwt)
  if (!u?.user) return {ok:false, reason:'invalid token'}
  const {data:prof} = await sb.from('profiles').select('role').eq('id', u.user.id).maybeSingle()
  if (!prof || !['super_admin','clinic_admin'].includes(prof.role)) return {ok:false, reason:'forbidden'}
  return {ok:true}
}

Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
  const h={...cors,'Content-Type':'application/json'}
  try{
    const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const az = await authorize(req, sb)
    if (!az.ok) return new Response(JSON.stringify({error:'unauthorized', reason:az.reason}),{status:401,headers:h})

    const url = new URL(req.url)
    const body = req.method === 'POST' ? await req.json().catch(()=>({})) : {}
    const mode = String(body.mode || url.searchParams.get('mode') || 'sync')

    const clinic=await sb.from('clinics').select('id').ilike('name','%Beauty Line%').limit(1).single()
    const cid=clinic.data?.id
    if(!cid)throw new Error('Clinic not found')

    // Πελατολόγιο της κλινικής, μία φορά — για το matching engine.
    const {data:patientsRows} = await sb.from('patients').select('id, full_name').eq('clinic_id', cid)
    const idx = new PatientIndex((patientsRows||[]) as PatientLite[])

    const result: Record<string, unknown> = {ok:true, mode}

    // ── SYNC: νέα emails ──
    if (mode === 'sync' || mode === 'both') {
      const token=await getToken()
      const labelId = await getOrCreateLabelId(token)
      let inserted=0, updated=0, skippedNoToken=0, parseFail=0, autoMatched=0

      // Φιλτράρουμε στο ίδιο query στο "άφησε μια κριτική" ώστε να μην πιάνουμε
      // άλλα emails του Google Business Profile (π.χ. υπενθυμίσεις για posts).
      const msgs = await gmailSearch(token, `from:businessprofile-noreply@google.com "άφησε μια κριτική" -label:${SYNCED_LABEL}`, 150)
      console.log('Ανεπεξέργαστα review emails:', msgs.length)

      for (const {id} of msgs) {
        const msg = await gmailGetFull(token, id)
        const html = extractHtml(msg.payload)
        if (!html) { parseFail++; await markSynced(token,id,labelId); continue }
        const lines = htmlToLines(html)
        const {stars, reviewerName, text, isTranslated} = parseReviewEmail(lines)
        const {reviewToken, locationFid} = extractReviewToken(html)
        if (!reviewerName || stars===null) {
          parseFail++
          console.log('Parse fail για μήνυμα', id, '— reviewerName:', reviewerName, 'stars:', stars)
          await markSynced(token,id,labelId)
          continue
        }
        if (!reviewToken) skippedNoToken++

        const reviewDate = new Date(parseInt(msg.internalDate||'0',10) || Date.now()).toISOString()
        const m = await matchReview(sb, cid, idx, reviewerName, reviewDate)
        if (m.status === 'auto_matched_high_confidence') autoMatched++

        const row: Record<string, unknown> = {
          clinic_id: cid,
          source: 'email',
          google_location_id: locationFid,
          google_review_id: reviewToken,
          gmail_message_id: id,
          reviewer_display_name: reviewerName,
          star_rating: stars,
          review_text: text,
          review_text_is_translated: isTranslated,
          review_create_time: reviewDate,
          matched_patient_id: m.matched_patient_id,
          matching_status: m.status,
          matching_confidence: m.confidence,
          matching_signals: m.signals,
          raw_payload: { gmail_message_id: id },
        }

        const {data:existing} = reviewToken
          ? await sb.from('google_reviews').select('id, matching_status').eq('clinic_id',cid).eq('source','email').eq('google_review_id',reviewToken).limit(1)
          : await sb.from('google_reviews').select('id, matching_status').eq('clinic_id',cid).eq('source','email').eq('gmail_message_id',id).limit(1)

        let writeError: string | null = null
        if (existing && existing.length) {
          const ex = existing[0]
          // Χειροκίνητη απόφαση προσωπικού ΔΕΝ ξαναγράφεται αυτόματα σε επόμενο
          // sync — κανόνας ασφαλείας από τον σχεδιασμό (ενότητα C).
          if (ex.matching_status === 'manually_confirmed' || ex.matching_status === 'manually_rejected') {
            const {error} = await sb.from('google_reviews').update({ star_rating: stars, review_text: text, review_text_is_translated: isTranslated }).eq('id', ex.id)
            writeError = error?.message || null
          } else {
            const {error} = await sb.from('google_reviews').update(row).eq('id', ex.id)
            writeError = error?.message || null
          }
          if (!writeError) updated++
        } else {
          const {error} = await sb.from('google_reviews').insert(row)
          writeError = error?.message || null
          if (!writeError) inserted++
        }

        if (writeError) { console.log('DB write error:', writeError) } // ΔΕΝ κάνουμε markSynced — ξαναπροσπαθεί στο επόμενο τρέξιμο
        else await markSynced(token, id, labelId)
      }

      console.log('Sync ολοκληρώθηκε:', inserted, 'νέα,', updated, 'ενημερωμένα,', parseFail, 'αποτυχίες parsing,', skippedNoToken, 'χωρίς review token,', autoMatched, 'auto-matched')
      result.reviews = {inserted, updated, parse_fail:parseFail, no_token:skippedNoToken, scanned:msgs.length, auto_matched:autoMatched}
    }

    // ── REMATCH: ξανατρέχει το engine στις εκκρεμείς κριτικές (χωρίς Gmail) ──
    if (mode === 'rematch' || mode === 'both') {
      const {data:pending} = await sb.from('google_reviews').select('id, reviewer_display_name, review_create_time, matching_status')
        .eq('clinic_id', cid).in('matching_status', ['unmatched','needs_review']).is('review_deleted_at', null).limit(2000)
      let scanned=0, nowHigh=0, nowNeeds=0, nowUnmatched=0
      for (const r of (pending||[])) {
        scanned++
        const m = await matchReview(sb, cid, idx, r.reviewer_display_name||'', r.review_create_time || new Date().toISOString())
        const {error} = await sb.from('google_reviews').update({
          matched_patient_id: m.matched_patient_id, matching_status: m.status, matching_confidence: m.confidence, matching_signals: m.signals,
        }).eq('id', r.id).in('matching_status', ['unmatched','needs_review']) // ποτέ πάνω από χειροκίνητη απόφαση
        if (error) { console.log('Rematch write error:', error.message); continue }
        if (m.status === 'auto_matched_high_confidence') nowHigh++
        else if (m.status === 'needs_review') nowNeeds++
        else nowUnmatched++
      }
      console.log('Rematch ολοκληρώθηκε:', scanned, 'έλεγχοι →', nowHigh, 'high,', nowNeeds, 'needs_review,', nowUnmatched, 'unmatched')
      result.rematch = {scanned, auto_matched:nowHigh, needs_review:nowNeeds, unmatched:nowUnmatched}
    }

    return new Response(JSON.stringify(result),{headers:h})
  }catch(e){
    console.log('ERROR:', e.message)
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:h})
  }
})
