/**
 * Booking247 → Google Sheet relay.
 *
 * Runs inside YOUR OWN Gmail account (via script.google.com) — no Google Cloud
 * OAuth app, no verification process, no expiring tokens. It reads new
 * booking emails from appointments@booking247.gr and appends one row per
 * appointment to a Google Sheet. A separate Supabase Edge Function (deployed
 * in the medi360 backend) polls that Sheet every minute and creates the
 * matching patient/appointment in the CRM.
 *
 * ONE-TIME SETUP
 * 1. Go to https://script.google.com → New project.
 * 2. Delete the default content, paste this whole file in, save.
 * 3. Create (or reuse) a Google Sheet to hold the rows, and paste its ID
 *    below into SHEET_ID (the long string in the sheet's URL between
 *    /d/ and /edit).
 * 4. Share that Sheet: "Anyone with the link → Viewer" (the CRM backend
 *    reads it as a public CSV export, same as the existing GDPR/Consultation
 *    sheet integrations already used in this app).
 * 5. In the Apps Script editor, select the function "installTrigger" in the
 *    toolbar dropdown and click "Run" once. Approve the Gmail/Sheets
 *    permission prompt (this is YOUR account authorizing YOUR OWN script —
 *    not a third-party app, so there's no Google verification step).
 * 6. Give the medi360 CRM admin this Sheet ID to paste into
 *    Ρυθμίσεις → Συνδέσεις → Booking247 Sheet ID.
 *
 * After that, this script runs automatically every 1 minute in the
 * background — no browser tab, no app open, nothing else needed.
 */

var SHEET_ID = 'PASTE_YOUR_SHEET_ID_HERE';
var SHEET_TAB = 'Ραντεβού'; // δημιουργείται αυτόματα αν δεν υπάρχει
var SYNCED_LABEL = 'CRM-Synced';
var HEADERS = ['MessageId', 'ReceivedAt', 'Πελάτης', 'Τηλέφωνο', 'Ημερομηνία', 'Ώρα',
               'Υπηρεσία', 'Προσωπικό', 'Διάρκεια (λεπτά)', 'Κατάσταση', 'Τιμή'];

function installTrigger() {
  // Καθαρίζει τυχόν παλιά ίδια triggers πριν φτιάξει το νέο, ώστε να μην τρέχει διπλά.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncBooking247Emails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncBooking247Emails').timeBased().everyMinutes(1).create();
  syncBooking247Emails(); // ένα άμεσο πρώτο run, για επιβεβαίωση ότι όλα δουλεύουν
}

function syncBooking247Emails() {
  var label = getOrCreateLabel_(SYNCED_LABEL);
  var threads = GmailApp.search('from:appointments@booking247.gr -label:' + SYNCED_LABEL, 0, 50);
  if (!threads.length) return;

  var sheet = getOrCreateSheet_();
  threads.forEach(function (thread) {
    var messages = thread.getMessages();
    messages.forEach(function (message) {
      if (message.getLabels && threadHasLabel_(thread, SYNCED_LABEL)) return;
      var parsed = parseBooking247Email_(message.getPlainBody());
      if (parsed) {
        sheet.appendRow([
          message.getId(),
          message.getDate(),
          parsed.name,
          parsed.phone,
          parsed.date,
          parsed.time,
          parsed.service,
          parsed.staff,
          parsed.duration,
          parsed.status,
          parsed.price === null ? '' : parsed.price,
        ]);
      }
    });
    thread.addLabel(label);
  });
}

function parseBooking247Email_(body) {
  // Ίδια μορφή/regex με το parseBooking247Email() του index.html — κρατάμε τα δύο σε βήμα.
  var name = (body.match(/Πελάτης:\s*([^\n]+?)(?:\s*\n|\s+Ημερομηνία|$)/i) || [])[1] || '';
  var date = (body.match(/Ημερομηνία:\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1] || '';
  var time = (body.match(/Ώρα:\s*(\d{1,2}:\d{2})/i) || [])[1] || '09:00';
  var service = (body.match(/Υπηρεσία:\s*([^\n]+?)(?:\s*\n|\s+Προσωπικό|$)/i) || [])[1] || '';
  var staff = (body.match(/Προσωπικό:\s*([^\n]+?)(?:\s*\n|\s+Τηλέφωνο|$)/i) || [])[1] || '';
  var phoneRaw = (body.match(/Τηλέφωνο πελάτη\s*:\s*([+\d\s]+)/i) || [])[1] || '';
  var durMatch = body.match(/Διάρκεια\s*Ραντεβού\s*:\s*(?:(\d+)\s*ω)?\s*(?:(\d+)\s*λ)?/i);
  var duration = 60;
  if (durMatch && (durMatch[1] || durMatch[2])) {
    duration = (parseInt(durMatch[1], 10) || 0) * 60 + (parseInt(durMatch[2], 10) || 0);
  }
  var status = (body.match(/Κατάσταση\s*Ραντεβού\s*:\s*([^\n]+?)(?:\s*\n|$)/i) || [])[1] || '';
  var priceRaw = (body.match(/Τιμή\s*ραντεβού\s*:\s*([\d.,]+)/i) || [])[1] || '';
  var phone = normalizePhone_(phoneRaw);
  if (!name || !date || !phone) return null; // χωρίς τηλέφωνο δεν γίνεται matching — αγνοείται
  var price = priceRaw ? parseFloat(priceRaw.replace(',', '.')) : null;
  return {
    name: name.trim(), phone: phone, date: date, time: time,
    service: service.trim(), staff: staff.trim(), duration: duration,
    status: status.trim(), price: isNaN(price) ? null : price,
  };
}

function normalizePhone_(p) {
  if (!p) return '';
  var digits = String(p).replace(/[^\d]/g, '');
  if (digits.indexOf('30') === 0 && digits.length > 10) digits = digits.slice(2);
  digits = digits.replace(/^0+/, '');
  return digits;
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function threadHasLabel_(thread, name) {
  return thread.getLabels().some(function (l) { return l.getName() === name; });
}

function getOrCreateSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TAB);
    sheet.appendRow(HEADERS);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  }
  return sheet;
}
