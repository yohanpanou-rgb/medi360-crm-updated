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
// Scheduled via pg_cron (job "google-reviews-sync-hourly"), καλεί με
// x-cron-secret (ίδιο secret με τα υπόλοιπα automations: BIRTHDAY_CRON_SECRET).
// Χρησιμοποιεί τα ΗΔΗ υπάρχοντα secrets GOOGLE_CLIENT_ID/CLIENT_SECRET/
// REFRESH_TOKEN (ίδια με gmail-auto-sync). SUPABASE_URL/SERVICE_ROLE_KEY
// injected αυτόματα. Redeploy μετά από αλλαγή:
//   supabase functions deploy google-reviews-sync

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, x-cron-secret'}
const SYNCED_LABEL = 'medi360-reviews-synced'
const REVIEW_MATCH_APPT_WINDOW_DAYS = 180 // "πρόσφατο ραντεβού" σήμα για HIGH confidence

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

Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
  const h={...cors,'Content-Type':'application/json'}
  try{
    const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const token=await getToken()
    const clinic=await sb.from('clinics').select('id').ilike('name','%Beauty Line%').limit(1).single()
    const cid=clinic.data?.id
    if(!cid)throw new Error('Clinic not found')

    const labelId = await getOrCreateLabelId(token)
    let inserted=0, updated=0, skippedNoToken=0, parseFail=0

    // Φιλτράρουμε στο ίδιο query στο "άφησε μια κριτική" ώστε να μην πιάνουμε
    // άλλα emails του Google Business Profile (π.χ. υπενθυμίσεις για posts).
    const msgs = await gmailSearch(token, `from:businessprofile-noreply@google.com "άφησε μια κριτική" -label:${SYNCED_LABEL}`, 150)
    console.log('Ανεπεξέργαστα review emails:', msgs.length)

    // Πελατολόγιο της κλινικής, μία φορά — για το matching engine.
    const {data:patientsRows} = await sb.from('patients').select('id, full_name').eq('clinic_id', cid)
    const patientIndex = new Map<string, {id:string, full_name:string}[]>()
    for (const p of (patientsRows||[])) {
      for (const v of nameVariants(p.full_name||'')) {
        if (!patientIndex.has(v)) patientIndex.set(v, [])
        patientIndex.get(v)!.push(p)
      }
    }

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

      // ── Matching engine (ενότητα C του σχεδιασμού) ──
      const variants = nameVariants(reviewerName)
      let candidates: {id:string, full_name:string}[] = []
      for (const v of variants) { const c = patientIndex.get(v); if (c) candidates = candidates.concat(c) }
      const uniqueCandidates = [...new Map(candidates.map(c=>[c.id,c])).values()]

      let matchingStatus = 'unmatched'
      let matchingConfidence: string|null = 'low'
      let matchedPatientId: string|null = null
      let hasRecentAppt = false

      if (uniqueCandidates.length === 1) {
        const cand = uniqueCandidates[0]
        const horizon = new Date(Date.now() - REVIEW_MATCH_APPT_WINDOW_DAYS*86400*1000).toISOString()
        const {data:apptRows} = await sb.from('appointments').select('id').eq('clinic_id',cid).eq('patient_id',cand.id).eq('is_internal',false).gte('start_time',horizon).limit(1)
        hasRecentAppt = !!(apptRows && apptRows.length)
        if (hasRecentAppt) {
          matchingStatus = 'auto_matched_high_confidence'
          matchingConfidence = 'high'
          matchedPatientId = cand.id
        } else {
          matchingStatus = 'needs_review'
          matchingConfidence = 'medium'
        }
      } else if (uniqueCandidates.length > 1) {
        matchingStatus = 'needs_review'
        matchingConfidence = 'medium'
      }

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
        matched_patient_id: matchedPatientId,
        matching_status: matchingStatus,
        matching_confidence: matchingConfidence,
        matching_signals: { name_variants: variants, candidate_count: uniqueCandidates.length, has_recent_appt: hasRecentAppt },
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

    console.log('Ολοκληρώθηκε:', inserted, 'νέα,', updated, 'ενημερωμένα,', parseFail, 'αποτυχίες parsing,', skippedNoToken, 'χωρίς review token')
    return new Response(JSON.stringify({ok:true, reviews:{inserted, updated, parse_fail:parseFail, no_token:skippedNoToken, scanned:msgs.length}}),{headers:h})
  }catch(e){
    console.log('ERROR:', e.message)
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:h})
  }
})
