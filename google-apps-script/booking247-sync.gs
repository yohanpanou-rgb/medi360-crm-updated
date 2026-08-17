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
  // Τιμή ραντεβού (τα emails online κρατήσεων την περιέχουν, π.χ. "38.00€") —
  // περνάει στο CRM ώστε το ραντεβού να καταχωρείται με σωστό ποσό.
  const priceMatch = clean.match(/Τιμή\s*ραντεβού\s*:\s*([\d.,]+)/i);
  const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '.')) : null;
  // Το τηλέφωνο είναι πλέον ΠΡΟΑΙΡΕΤΙΚΟ: κράτηση χωρίς τηλέφωνο περνάει στο
  // CRM με ταίριασμα ονόματος (το booking247-ingest το χειρίζεται) αντί να
  // χάνεται σιωπηλά.
  if (!name || !date) return null;
  return { name: name.trim(), phone: phone.trim(), date, time, service: service.trim(), staff: staff.trim(), duration, price };
}

// ── Παρακολούθηση ΑΝΑ EMAIL (όχι ανά συζήτηση) ──
// Τα Gmail labels εφαρμόζονται σε επίπεδο ΣΥΖΗΤΗΣΗΣ: αν δύο emails κρατήσεων
// ομαδοποιηθούν στην ίδια συζήτηση (ίδιο θέμα), το δεύτερο που έφτανε μετά το
// label ΔΕΝ το έβλεπε ποτέ η αναζήτηση "-label:medi360-synced" — αυτός ήταν ο
// λόγος που "χάνονταν" ραντεβού. Τώρα κρατάμε τα IDs των επεξεργασμένων emails
// στα Script Properties και ελέγχουμε κάθε email ξεχωριστά· το label μένει
// μόνο ως οπτική ένδειξη στο Gmail.
function getProcessedIds_() {
  const raw = PropertiesService.getScriptProperties().getProperty('PROCESSED_IDS');
  return raw ? JSON.parse(raw) : [];
}
function saveProcessedIds_(ids) {
  // κρατάμε τα πιο πρόσφατα 2000 — υπεραρκετά για το παράθυρο αναζήτησης 7 ημερών
  PropertiesService.getScriptProperties().setProperty('PROCESSED_IDS', JSON.stringify(ids.slice(-2000)));
}

function syncBooking247Emails() {
  const label = getOrCreateLabel_();
  const processedIds = getProcessedIds_();
  const processedSet = new Set(processedIds);
  const firstRun = processedIds.length === 0; // μετάβαση από το παλιό σύστημα (μόνο labels)

  // Ολόκληρο το domain booking247.gr — τα emails online κρατήσεων πελατών
  // ("Νέα κράτηση από πελάτη") έρχονται από διαφορετικό αποστολέα απ' ό,τι οι
  // ειδοποιήσεις προσωπικού, και με το παλιό from:appointments@ χάνονταν.
  const threads = GmailApp.search('from:booking247.gr newer_than:7d', 0, 100);
  if (!threads.length) return;

  const rows = [];
  const threadsByRow = [];
  const seededIds = [];
  threads.forEach(thread => {
    const messages = thread.getMessages();
    const threadLabeled = thread.getLabels().some(l => l.getName() === SYNCED_LABEL);
    messages.forEach(message => {
      const id = message.getId();
      if (processedSet.has(id)) return;
      // Πρώτο τρέξιμο μετά την αναβάθμιση: συζήτηση με label και ΕΝΑ μόνο email
      // είναι σίγουρα ήδη περασμένη — καταγράφεται χωρίς να ξανασταλεί. Συζήτηση
      // με label και ΠΟΛΛΑ emails είναι η ύποπτη περίπτωση των χαμένων ραντεβού:
      // στέλνονται όλα (ο server αναγνωρίζει τα ήδη περασμένα ως duplicates).
      if (firstRun && threadLabeled && messages.length === 1) { seededIds.push(id); return; }
      const text = message.getPlainBody() || message.getBody().replace(/<[^>]+>/g, ' ');
      const parsed = parseBooking247Email_(text);
      if (!parsed) { seededIds.push(id); thread.addLabel(label); return; } // δεν έγινε parse — μην το ξαναδοκιμάζεις επ' άπειρον
      rows.push(Object.assign({ messageId: id }, parsed));
      threadsByRow.push(thread);
    });
  });

  if (!rows.length) {
    if (seededIds.length) saveProcessedIds_(processedIds.concat(seededIds));
    return;
  }

  const resp = UrlFetchApp.fetch(INGEST_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-secret': INGEST_SECRET },
    payload: JSON.stringify({ rows }),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    console.log('Ingest failed: ' + resp.getContentText());
    if (seededIds.length) saveProcessedIds_(processedIds.concat(seededIds));
    return; // τα rows ΔΕΝ καταγράφονται — ξαναδοκιμάζονται όλα στο επόμενο τρέξιμο
  }
  const result = JSON.parse(resp.getContentText());
  const okIds = new Set((result.results || []).filter(r => r.ok).map(r => r.messageId));
  const newlyDone = [];
  rows.forEach((row, i) => {
    if (okIds.has(row.messageId)) {
      newlyDone.push(row.messageId);
      threadsByRow[i].addLabel(label); // οπτική ένδειξη στο Gmail
    }
    // αν απέτυχε (π.χ. σφάλμα βάσης), ΔΕΝ καταγράφεται — ξαναδοκιμάζεται στο επόμενο τρέξιμο
  });
  saveProcessedIds_(processedIds.concat(seededIds, newlyDone));
}

/**
 * ── Φάκελος Εξετάσεων: αυτόματη εισαγωγή από emails πελατών ──────────────
 *
 * Ίδια λογική/λόγος ύπαρξης με το syncBooking247Emails παραπάνω (Apps
 * Script αντί για Supabase OAuth function, ώστε να μη λήγει ποτέ) — απλά
 * διαφορετικός στόχος: κάθε πόσο λεπτά ψάχνει ΟΛΟ το inbox για emails με
 * συνημμένο· αν ο αποστολέας ταιριάζει με το email καταχωρημένου πελάτη στο
 * CRM, τα συνημμένα (φωτογραφία/PDF) στέλνονται στο exam-ingest, που τα
 * βάζει στον φάκελο "Εξετάσεις" της κάρτας του πελάτη και ζητάει AI
 * ταξινόμηση. Ξεχωριστό label/ξεχωριστό tracking από το booking247 sync
 * παραπάνω — δεν επηρεάζει το ένα το άλλο.
 *
 * Setup (one-time, ΞΕΧΩΡΙΣΤΟ από το installTrigger — τρέξε ΚΑΙ τα δύο):
 *   1. Ενημέρωσε το EXAM_INGEST_SECRET παρακάτω ώστε να ταιριάζει με το
 *      EXAM_INGEST_SECRET που έβαλες στο exam-ingest Supabase function.
 *   2. Επίλεξε τη συνάρτηση "installExamTrigger" στο toolbar → ▶ Run.
 *   3. Ίδιο permissions prompt με πριν αν δεν το έχεις ήδη εγκρίνει — Allow.
 */

const EXAM_INGEST_URL = 'https://kfidxwqgsaisbdgucsok.supabase.co/functions/v1/exam-ingest';
const EXAM_INGEST_SECRET = 'PASTE_THE_SAME_VALUE_YOU_SET_FOR_EXAM_INGEST_SECRET';
const EXAM_SYNCED_LABEL = 'medi360-exam-synced';
const EXAM_ELIGIBLE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const EXAM_MIN_BYTES = 4000; // αγνοεί μικρά inline λογότυπα/υπογραφές email

function installExamTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncExamAttachments') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncExamAttachments').timeBased().everyMinutes(5).create();
  syncExamAttachments(); // τρέξε μία φορά αμέσως
}

function getOrCreateExamLabel_() {
  return GmailApp.getUserLabelByName(EXAM_SYNCED_LABEL) || GmailApp.createLabel(EXAM_SYNCED_LABEL);
}

function getProcessedExamIds_() {
  const raw = PropertiesService.getScriptProperties().getProperty('PROCESSED_EXAM_IDS');
  return raw ? JSON.parse(raw) : [];
}
function saveProcessedExamIds_(ids) {
  PropertiesService.getScriptProperties().setProperty('PROCESSED_EXAM_IDS', JSON.stringify(ids.slice(-2000)));
}

// "Maria G" <maria@gmail.com>  →  maria@gmail.com
function extractEmailAddress_(fromHeader) {
  const m = /<([^>]+)>/.exec(fromHeader || '');
  const addr = (m ? m[1] : (fromHeader || '')).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : '';
}

function syncExamAttachments() {
  const label = getOrCreateExamLabel_();
  const processedIds = getProcessedExamIds_();
  const processedSet = new Set(processedIds);

  const threads = GmailApp.search('has:attachment newer_than:14d -label:' + EXAM_SYNCED_LABEL, 0, 50);
  if (!threads.length) return;

  const rows = [];
  const messageIdsInBatch = new Set();
  const seededIds = [];

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      const id = message.getId();
      if (processedSet.has(id)) return;

      const senderEmail = extractEmailAddress_(message.getFrom());
      const atts = senderEmail ? message.getAttachments({ includeInlineImages: false, includeAttachments: true }) : [];
      const eligible = atts.filter(a => EXAM_ELIGIBLE_TYPES.indexOf(a.getContentType()) !== -1 && a.getSize() >= EXAM_MIN_BYTES);

      if (!senderEmail || !eligible.length) { seededIds.push(id); return; } // όχι πελάτης ή τίποτα αξιόλογο να εισαχθεί

      const dateIso = Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      eligible.forEach(att => {
        rows.push({
          messageId: id, senderEmail: senderEmail, filename: att.getName(),
          mimeType: att.getContentType(), dataBase64: Utilities.base64Encode(att.getBytes()), dateIso: dateIso,
        });
      });
      messageIdsInBatch.add(id);
    });
  });

  if (!rows.length) {
    if (seededIds.length) saveProcessedExamIds_(processedIds.concat(seededIds));
    return;
  }

  const resp = UrlFetchApp.fetch(EXAM_INGEST_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-secret': EXAM_INGEST_SECRET },
    payload: JSON.stringify({ rows: rows }),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    console.log('Exam ingest failed: ' + resp.getContentText());
    if (seededIds.length) saveProcessedExamIds_(processedIds.concat(seededIds));
    return; // τίποτα δεν καταγράφεται ως done — ξαναδοκιμάζονται όλα στο επόμενο τρέξιμο
  }
  const result = JSON.parse(resp.getContentText());

  // Ένα μήνυμα σημειώνεται "done" ΜΟΝΟ αν ΟΛΑ τα συνημμένα του πέτυχαν (created
  // ή duplicate) — αν κάποιο απέτυχε, ξαναδοκιμάζεται ολόκληρο το μήνυμα στο
  // επόμενο τρέξιμο· τα ήδη επιτυχημένα απλά θα ξαναγυρίσουν ως "duplicate"
  // χάρη στο dedup του exam-ingest, άρα είναι ασφαλές.
  const okByMessage = {};
  (result.results || []).forEach(r => {
    if (!(r.messageId in okByMessage)) okByMessage[r.messageId] = true;
    okByMessage[r.messageId] = okByMessage[r.messageId] && !!r.ok;
  });
  const newlyDone = [];
  messageIdsInBatch.forEach(id => {
    if (okByMessage[id]) {
      newlyDone.push(id);
      GmailApp.getMessageById(id).getThread().addLabel(label); // οπτική ένδειξη στο Gmail
    }
  });
  saveProcessedExamIds_(processedIds.concat(seededIds, newlyDone));
}
