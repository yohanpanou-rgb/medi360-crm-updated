// Supabase Edge Function — ΕΦΕΔΡΙΚΟ κανάλι Booking247 → CRM (backup του Apps Script).
//
// Ιστορικό: αυτή η function ήταν το αρχικό κανάλι (διάβαζε το Gmail με OAuth
// refresh token και έφτιαχνε η ίδια ασθενείς/ραντεβού). Αντικαταστάθηκε από το
// Google Apps Script (google-apps-script/booking247-sync.gs → booking247-ingest)
// επειδή τότε το OAuth token έληγε κάθε 7 μέρες (consent screen σε "Testing").
// Από 24/09/2026 το consent screen είναι "In production" (μόνιμο token, ίδιο
// με το google-reviews-sync), οπότε ξαναζωντάνεψε ως ΕΦΕΔΡΕΙΑ: αν το Apps
// Script σταματήσει (όπως έγινε 24/09 μετά τις 16:51), οι κρατήσεις περνούν
// από εδώ μέσα σε 1 λεπτό.
//
// ΔΕΝ ξαναγράφει τη λογική δημιουργίας ραντεβού: διαβάζει τα emails, τα
// κάνει parse ΑΚΡΙΒΩΣ όπως το Apps Script (parseBooking247Email_) και τα
// προωθεί στο booking247-ingest, που κάνει το ταίριασμα ασθενή, τον έλεγχο
// διπλότυπων (match_appt_by_local_time) και την εισαγωγή. Έτσι Apps Script
// και εφεδρεία συμπεριφέρονται πανομοιότυπα και ό,τι έχει ήδη περάσει
// αναγνωρίζεται ως duplicate.
//
// Scheduled via pg_cron (job "gmail-auto-sync-backup", `* * * * *`), με header
// x-cron-secret = BIRTHDAY_CRON_SECRET (ίδιο με τα υπόλοιπα automations).
// Required secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// (Gmail που λαμβάνει τα emails Booking247 — yohan.panou@gmail.com, scope
// gmail.modify), BOOKING247_INGEST_SECRET (ίδιο με το ingest), BIRTHDAY_CRON_SECRET.
// Redeploy: supabase functions deploy gmail-auto-sync --no-verify-jwt

const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, x-cron-secret'}
const SYNCED_LABEL = 'medi360-synced'      // ίδιο όνομα με το Apps Script (άλλο mailbox όμως)
const SEARCH_WINDOW = 'newer_than:7d'      // ίδιο παράθυρο με το Apps Script
// Emails ΠΡΙΝ από αυτή τη στιγμή είχαν ήδη περάσει από το Apps Script όταν
// ενεργοποιήθηκε η εφεδρεία — απλώς μαρκάρονται ως επεξεργασμένα, δεν
// ξαναστέλνονται (αποφεύγει να ξαναδημιουργηθεί ραντεβού που στο μεταξύ
// διαγράφηκε/άλλαξε χειροκίνητα στο CRM).
const BACKUP_SINCE_MS = Date.parse('2026-09-24T17:00:00Z')

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

// Πλήρες κείμενο email: προτιμάται το text/plain (όπως getPlainBody() στο Apps
// Script), αλλιώς το HTML χωρίς tags.
function extractPlainText(payload:any): string {
  if (!payload) return ''
  if (payload.mimeType==='text/plain' && payload.body?.data) return decodeB64(payload.body.data)
  if (payload.parts) { for (const p of payload.parts) { const t=extractPlainText(p); if (t) return t } }
  return ''
}
function extractHtmlText(payload:any): string {
  if (!payload) return ''
  if (payload.mimeType==='text/html' && payload.body?.data) return decodeB64(payload.body.data).replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|div|tr|li)>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&')
  if (payload.parts) { for (const p of payload.parts) { const t=extractHtmlText(p); if (t) return t } }
  if (payload.body?.data) return decodeB64(payload.body.data).replace(/<[^>]+>/g,' ')
  return ''
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

// Το Gmail API (σε αντίθεση με το GmailApp του Apps Script) βάζει labels ΑΝΑ
// ΜΗΝΥΜΑ και η αναζήτηση -label: φιλτράρει ανά μήνυμα — άρα δύο κρατήσεις στην
// ίδια συζήτηση δεν χάνονται.
async function markSynced(token:string, id:string, labelId:string) {
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`,{
    method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({addLabelIds:[labelId]})
  })
}

// ΙΔΙΟ parsing με το parseBooking247Email_ του Apps Script — αν αλλάξει το ένα,
// να αλλάξει και το άλλο.
function parseBooking247Email(text:string) {
  const clean = (text||'').replace(/\r/g, '')
  const name = (clean.match(/Πελάτης:\s*([^\n]+?)(?:\n|\s+Ημερομηνία|$)/i) || [])[1] || ''
  const date = (clean.match(/Ημερομηνία:\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1] || ''
  const time = (clean.match(/Ώρα:\s*(\d{1,2}:\d{2})/i) || [])[1] || '09:00'
  const service = (clean.match(/Υπηρεσία:\s*([^\n]+?)(?:\n|\s+Προσωπικό|$)/i) || [])[1] || ''
  const staff = (clean.match(/Προσωπικό:\s*([^\n]+?)(?:\n|\s+Τηλέφωνο|$)/i) || [])[1] || ''
  const phone = (clean.match(/Τηλέφωνο πελάτη\s*:\s*([+\d\s]+)/i) || [])[1] || ''
  const durMatch = clean.match(/Διάρκεια\s*Ραντεβού\s*:\s*(?:(\d+)\s*ω)?\s*(?:(\d+)\s*λ)?/i)
  let duration = 60
  if (durMatch && (durMatch[1] || durMatch[2])) duration = (parseInt(durMatch[1], 10) || 0) * 60 + (parseInt(durMatch[2], 10) || 0)
  const priceMatch = clean.match(/Τιμή\s*ραντεβού\s*:\s*([\d.,]+)/i)
  const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '.')) : null
  if (!name || !date) return null
  return { name: name.trim(), phone: phone.trim(), date, time, service: service.trim(), staff: staff.trim(), duration, price }
}

Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
  const h={...cors,'Content-Type':'application/json'}
  try{
    const secret = Deno.env.get('BIRTHDAY_CRON_SECRET')
    if (!secret || req.headers.get('x-cron-secret') !== secret) return new Response(JSON.stringify({error:'unauthorized'}),{status:401,headers:h})

    const token=await getToken()
    const labelId = await getOrCreateLabelId(token)
    const ingestUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/booking247-ingest`
    const ingestSecret = Deno.env.get('BOOKING247_INGEST_SECRET') || ''

    const msgs=await gmailSearch(token,`from:booking247.gr ${SEARCH_WINDOW} -label:${SYNCED_LABEL}`,100)
    let seeded=0, parseFail=0
    const rows: Record<string,unknown>[] = []
    for (const {id} of msgs) {
      const msg=await gmailGetFull(token,id)
      const internal = parseInt(msg.internalDate||'0',10)
      if (internal && internal < BACKUP_SINCE_MS) { seeded++; await markSynced(token,id,labelId); continue }
      const text = extractPlainText(msg.payload) || extractHtmlText(msg.payload) || msg.snippet || ''
      const parsed = parseBooking247Email(text)
      if (!parsed) { parseFail++; await markSynced(token,id,labelId); continue }
      rows.push({ messageId:id, ...parsed })
    }

    let created=0, duplicate=0, failed=0
    if (rows.length) {
      const r = await fetch(ingestUrl,{method:'POST',headers:{'Content-Type':'application/json','x-ingest-secret':ingestSecret},body:JSON.stringify({rows})})
      if (r.status !== 200) {
        const t = await r.text()
        console.log('Ingest failed:', r.status, t)
        return new Response(JSON.stringify({ok:false, error:'ingest_failed', status:r.status, detail:t.slice(0,300), scanned:msgs.length, seeded}),{status:502,headers:h})
      }
      const result = await r.json()
      for (const res of (result.results||[])) {
        if (res.ok) { if (res.reason==='duplicate') duplicate++; else created++; await markSynced(token, res.messageId, labelId) }
        else { failed++; console.log('Row failed:', res.messageId, res.reason) } // μένει χωρίς label → ξαναδοκιμάζεται
      }
    }

    console.log('Backup sync:', msgs.length, 'emails →', created, 'νέα,', duplicate, 'διπλότυπα,', failed, 'αποτυχίες,', parseFail, 'μη-parse,', seeded, 'seeded')
    return new Response(JSON.stringify({ok:true, scanned:msgs.length, created, duplicate, failed, parse_fail:parseFail, seeded}),{headers:h})
  }catch(e){
    console.log('ERROR:', e.message)
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:h})
  }
})
