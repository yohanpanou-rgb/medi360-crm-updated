/**
 * Booking247 → CRM sync, running directly under this Gmail account.
 *
 * Why this exists: the previous approach (a "gmail-auto-sync" Supabase Edge
 * Function using a Google OAuth client) breaks every ~7 days, because
 * Google auto-expires refresh tokens for OAuth apps left in "Testing"
 * publishing status — and publishing to Production with the gmail.readonly
 * scope requires Google verification, which isn't practical for a single
 * clinic's personal (non-Workspace) Gmail account.
 *
 * Apps Script bound to your own Google account doesn't have that problem:
 * you authorize it once (a single "Review permissions" click when you first
 * run installTrigger below) and it keeps working indefinitely — no OAuth
 * client, no refresh token, nothing that expires.
 *
 * What it does: every minute, searches this Gmail account for unprocessed
 * emails from appointments@booking247.gr, parses each one, and POSTs the
 * parsed appointments to the booking247-ingest Supabase Edge Function,
 * which does the patient-matching + appointment-creation. Successfully
 * ingested emails get a Gmail label ("medi360-synced") so they're never
 * re-sent — this is the SAME label the old gmail-auto-sync function used,
 * so anything it already processed is correctly skipped here too.
 *
 * Setup (one-time):
 *   1. https://script.google.com/home → New project → replace the default
 *      code with this whole file.
 *   2. Update INGEST_URL (if it ever changes) and INGEST_SECRET below —
 *      INGEST_SECRET must match the BOOKING247_INGEST_SECRET secret set on
 *      the booking247-ingest Supabase Edge Function.
 *   3. In the toolbar, select the "installTrigger" function → click ▶ Run.
 *      Google will show a permissions prompt (this script wants to read/
 *      modify your Gmail) — click through "Advanced" → "Go to (project
 *      name) (unsafe)" → Allow. This is expected: it's your own script,
 *      Google just doesn't have anything to verify since you're the only
 *      user.
 *   4. Done. It now runs every minute on its own — no further maintenance,
 *      no token to ever refresh again.
 */

const INGEST_URL = 'https://kfidxwqgsaisbdgucsok.supabase.co/functions/v1/booking247-ingest';
const INGEST_SECRET = 'PASTE_THE_SAME_VALUE_YOU_SET_FOR_BOOKING247_INGEST_SECRET';
const SYNCED_LABEL = 'medi360-synced';

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncBooking247Emails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncBooking247Emails').timeBased().everyMinutes(1).create();
  syncBooking247Emails(); // τρέξε μία φορά αμέσως, μην περιμένεις το πρώτο λεπτό
}

function getOrCreateLabel_() {
  return GmailApp.getUserLabelByName(SYNCED_LABEL) || GmailApp.createLabel(SYNCED_LABEL);
}

function parseBooking247Email_(text) {
  const clean = text.replace(/\r/g, '');
  const name = (clean.match(/Πελάτης:\s*([^\n]+?)(?:\n|\s+Ημερομηνία|$)/i) || [])[1] || '';
  const date = (clean.match(/Ημερομηνία:\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1] || '';
  const time = (clean.match(/Ώρα:\s*(\d{1,2}:\d{2})/i) || [])[1] || '09:00';
  const service = (clean.match(/Υπηρεσία:\s*([^\n]+?)(?:\n|\s+Προσωπικό|$)/i) || [])[1] || '';
  const staff = (clean.match(/Προσωπικό:\s*([^\n]+?)(?:\n|\s+Τηλέφωνο|$)/i) || [])[1] || '';
  const phone = (clean.match(/Τηλέφωνο πελάτη\s*:\s*([+\d\s]+)/i) || [])[1] || '';
  const durMatch = clean.match(/Διάρκεια\s*Ραντεβού\s*:\s*(?:(\d+)\s*ω)?\s*(?:(\d+)\s*λ)?/i);
  let duration = 60;
  if (durMatch && (durMatch[1] || durMatch[2])) {
    duration = (parseInt(durMatch[1], 10) || 0) * 60 + (parseInt(durMatch[2], 10) || 0);
  }
  if (!name || !date || !phone) return null;
  return { name: name.trim(), phone: phone.trim(), date, time, service: service.trim(), staff: staff.trim(), duration };
}

function syncBooking247Emails() {
  const label = getOrCreateLabel_();
  const threads = GmailApp.search(`from:appointments@booking247.gr -label:${SYNCED_LABEL}`, 0, 100);
  if (!threads.length) return;

  const rows = [];
  const messagesByRow = [];
  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      if (message.getLabels().some(l => l.getName() === SYNCED_LABEL)) return;
      const text = message.getPlainBody() || message.getBody().replace(/<[^>]+>/g, ' ');
      const parsed = parseBooking247Email_(text);
      if (!parsed) { message.addLabel(label); return; } // δεν έγινε parse — μην το ξαναδοκιμάζεις επ' άπειρον
      rows.push(Object.assign({ messageId: message.getId() }, parsed));
      messagesByRow.push(message);
    });
  });
  if (!rows.length) return;

  const resp = UrlFetchApp.fetch(INGEST_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-secret': INGEST_SECRET },
    payload: JSON.stringify({ rows }),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    console.log('Ingest failed: ' + resp.getContentText());
    return; // μην κάνεις label τίποτα — ξαναδοκίμασε όλα στο επόμενο τρέξιμο
  }
  const result = JSON.parse(resp.getContentText());
  const okIds = new Set((result.results || []).filter(r => r.ok).map(r => r.messageId));
  messagesByRow.forEach(message => {
    if (okIds.has(message.getId())) message.addLabel(label);
    // αν απέτυχε (π.χ. σφάλμα βάσης), ΔΕΝ κάνουμε label — ξαναδοκιμάζεται στο επόμενο τρέξιμο
  });
}
