// Supabase Edge Function — THE REAL, ACTIVE Booking247 sync. Reads Gmail
// directly via a server-side OAuth refresh token (no browser, no relay
// Sheet), parses appointment emails from appointments@booking247.gr, and
// creates/matches the patient + appointment in the CRM.
//
// Scheduled every 5 minutes via pg_cron (job "gmail-auto-sync",
// `*/5 * * * *`), calling this function's URL with the service_role key.
// This file previously existed only in production (never committed) — added
// here so it's tracked like the rest of the codebase. Redeploy after any
// change with:
//   supabase functions deploy gmail-auto-sync
//
// Required secrets (set via `supabase secrets set`):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//   (OAuth credentials for the Gmail account that receives Booking247 emails)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type'}
const SYNCED_LABEL = 'medi360-synced' // ΝΕΟ label, ξεχωριστό από τυχόν παλιό "Booking247-Synced" Gmail filter

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

// Εξάγει το ΠΛΗΡΕΣ κείμενο του email (όχι μόνο το κομμένο snippet) — αποφεύγει το κόψιμο πεδίων όπως "Διάρκεια Ραντεβού"
function extractFullText(payload:any): string {
  if (!payload) return ''
  if (payload.mimeType==='text/plain' && payload.body?.data) return decodeB64(payload.body.data)
  if (payload.parts) { for (const p of payload.parts) { const t=extractFullText(p); if (t) return t } }
  if (payload.body?.data) return decodeB64(payload.body.data)
  return ''
}

// ── LABEL MANAGEMENT: βρες ή δημιούργησε το label "medi360-synced" ──
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

// Σήμανση email ως επεξεργασμένο — ΔΕΝ θα ξαναδιαβαστεί σε επόμενο τρέξιμο, όσο παλιό κι αν είναι
async function markSynced(token:string, id:string, labelId:string) {
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`,{
    method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({addLabelIds:[labelId]})
  })
}

function phone(s:string){
  if(!s)return ''
  let d=s.replace(/[^\d]/g,'')
  // "00" διεθνές πρόθεμα (π.χ. 0039...) ισοδυναμεί με "+" — αφαίρεσέ το πριν
  // ελέγξουμε για ελληνικό κωδικό χώρας, αλλιώς π.χ. "0030..." δεν αναγνωρίζεται.
  if(d.startsWith('00')&&d.length>10)d=d.slice(2)
  if(d.startsWith('30')&&d.length>10)d=d.slice(2)
  return d.replace(/^0+/,'')
}

function normalizePatientName(s:string): string {
  // Στα κεφαλαία ελληνικά τα φωνήεντα γράφονται χωρίς τόνο (ΓΕΩΡΓΙΑ, όχι ΓΕΩΡΓΊΑ) —
  // ίδια σύμβαση με το normalizePatientName του index.html.
  return (s||'')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/́/g, '')
    .normalize('NFC')
}

function parseB247(snippet:string) {
  const txt = snippet
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>')
    .replace(/&#39;/gi,"'")
    .replace(/&quot;/gi,'"')
    .replace(/<[^>]*>/g,' ')
    .replace(/\s+/g,' ')
  const name=(txt.match(/Πελάτης:\s*([^\n]+?)(?:\s+Ημερομηνία|\s+Ώρα|$)/i)||[])[1]?.trim()||''
  const date=(txt.match(/Ημερομηνία:\s*(\d{2}\/\d{2}\/\d{4})/i)||[])[1]||''
  const time=(txt.match(/Ώρα:\s*(\d{1,2}:\d{2})/i)||[])[1]||'09:00'
  const svc=(txt.match(/Υπηρεσία:\s*([^\n]+?)(?:\s+Προσωπικό|\s+Τηλέφωνο|$)/i)||[])[1]?.trim()||''
  const staff=(txt.match(/Προσωπικό:\s*([^\n]+?)(?:\s+Τηλέφωνο|$)/i)||[])[1]?.trim()||''
  const ph=phone((txt.match(/Τηλέφωνο πελάτη\s*:\s*([+\d\s]+)/i)||[])[1]||'')
  const dm=txt.match(/Διάρκεια\s*Ραντεβού\s*:\s*(?:(\d+)\s*ω)?\s*(?:(\d+)\s*λ)?/i)
  const dur=dm?(parseInt(dm[1]||'0')*60+parseInt(dm[2]||'0'))||60:60
  if(!name||!date||!ph) return null
  const [d,m,y]=date.split('/');const [h,mn]=time.split(':')
  const st=`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${(h||'09').padStart(2,'0')}:${(mn||'00').padStart(2,'0')}:00`
  return {name,ph,svc,staff,dur,st}
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
    let apptOk=0,apptSkip=0,parseFail=0

    // ΧΩΡΙΣ χρονικό παράθυρο — μόνο emails που ΔΕΝ έχουν ακόμα το label επεξεργασίας.
    // Έτσι backlog emails (π.χ. από παλιά διακοπή του sync) περνάνε κανονικά, όσο παλιά κι αν είναι.
    const msgs=await gmailSearch(token,`from:appointments@booking247.gr -label:${SYNCED_LABEL}`,150)
    console.log('Ανεπεξέργαστα emails:',msgs.length)

    await Promise.all(msgs.map(async({id})=>{
      const msg=await gmailGetFull(token,id)
      const fullText=extractFullText(msg.payload)
      const snippet=fullText || msg.snippet || ''
      if(!snippet){parseFail++; await markSynced(token,id,labelId); return}
      const p=parseB247(snippet)
      if(!p){parseFail++; await markSynced(token,id,labelId); return}

      let {data:pts}=await sb.from('patients').select('id').eq('clinic_id',cid).ilike('phone','%'+p.ph+'%').limit(1)
      let pid=pts?.[0]?.id
      if(!pid){
        const {data:np}=await sb.from('patients').insert({clinic_id:cid,full_name:normalizePatientName(p.name),phone:p.ph,status:'active',source:'booking247'}).select('id').single()
        pid=np?.id
      }
      if(!pid){ await markSynced(token,id,labelId); return }

      const {data:ex}=await sb.rpc('match_appt_by_local_time', {p_clinic_id:cid, p_patient_id:pid, p_local_ts:p.st})
      if(ex?.length){ apptSkip++; await markSynced(token,id,labelId); return }

      const {error}=await sb.from('appointments').insert({clinic_id:cid,patient_id:pid,service_name:p.svc,start_time:p.st,duration_minutes:p.dur,status:'confirmed',notes:p.staff?'Προσωπικό: '+p.staff:''})
      if(error){ console.log('Insert error:',error.message) } // ΔΕΝ κάνουμε markSynced σε DB error — ξαναπροσπαθεί στο επόμενο τρέξιμο
      else { apptOk++; await markSynced(token,id,labelId) }
    }))

    console.log('Ολοκληρώθηκε:',apptOk,'νέα,',apptSkip,'διπλότυπα,',parseFail,'αποτυχίες parsing')
    return new Response(JSON.stringify({ok:true,appointments:{inserted:apptOk,skipped:apptSkip,parse_fail:parseFail,scanned:msgs.length}}),{headers:h})
  }catch(e){
    console.log('ERROR:',e.message)
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:h})
  }
})
