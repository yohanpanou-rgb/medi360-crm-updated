// nameday-sms — «Εορτολόγιο & SMS» (πλατφορμικό feature, ανά οργανισμό/κλινική).
//
// Τι κάνει:
//  • Βρίσκει ποια ελληνικά ονόματα γιορτάζουν σήμερα (σταθερές + κινητές εορτές
//    με βάση το Ορθόδοξο Πάσχα).
//  • Ταιριάζει ΜΟΝΟ τους πελάτες της συγκεκριμένης κλινικής (ποτέ cross-tenant),
//    με ανοχή σε πεζά/κεφαλαία, τόνους, λατινικούς χαρακτήρες (greeklish) και
//    ξεκάθαρες παραλλαγές/υποκοριστικά. Καμία «περίπου» αντιστοίχιση.
//  • Φτιάχνει προσωποποιημένο SMS με το ΜΙΚΡΟ όνομα μόνο (ποτέ επώνυμο).
//  • Δεν στέλνει ποτέ δεύτερο SMS στον ίδιο πελάτη την ίδια ημέρα
//    (unique (clinic_id, patient_id, nameday_date) στον nameday_sms_log).
//
// Feature flag: clinics.settings.nameday_sms =
//   { enabled, approval_required, auto_send, template, org_name, send_hour, sender_id }
// Κλινική με enabled=false: preview επιστρέφει enabled:false, send απορρίπτεται,
// το cron την προσπερνά.
//
// Actions (POST JSON):
//   { action:'preview',   clinic_id, date? }            → λίστα εορταζόντων + μηνύματα
//   { action:'send',      clinic_id, patient_ids?, date? } → αποστολή (μετά από έγκριση στο CRM)
//   { action:'test_send', clinic_id, phone, first_name? } → 1 δοκιμαστικό SMS
//   { action:'calendar',  date? }                       → ονόματα της ημέρας
//   {} από cron (x-cron-secret)                          → auto_send κλινικές, την ώρα send_hour
//
// Auth: x-cron-secret (BIRTHDAY_CRON_SECRET) Ή Supabase JWT χρήστη που ανήκει
// στην κλινική (ή super_admin). Deploy με verify_jwt=false (όπως appointment-automations).
// Secrets: BIRTHDAY_CRON_SECRET, APIFON_TOKEN, APIFON_API_KEY, APIFON_SENDER_ID.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

const DEFAULT_TEMPLATE = '{name}, χρόνια πολλά για τη γιορτή σου! Η ομάδα του {clinic}';

// ─────────────────────────────────────────────────────────────────────────────
// Ημερομηνίες (Αθήνα)
// ─────────────────────────────────────────────────────────────────────────────
function athensParts(d = new Date()): { y: number; m: number; d: number; hour: number; iso: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => Number((parts.find((p) => p.type === t) || { value: '0' }).value);
  const y = get('year'), m = get('month'), day = get('day');
  return { y, m, d: day, hour: get('hour'), iso: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

// Ορθόδοξο Πάσχα (αλγόριθμος Meeus για Ιουλιανό + 13 ημέρες για Γρηγοριανό, 1900–2099).
function orthodoxEaster(year: number): { m: number; d: number } {
  const a = year % 4, b = year % 7, c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const jul = new Date(Date.UTC(year, month - 1, day));
  jul.setUTCDate(jul.getUTCDate() + 13);
  return { m: jul.getUTCMonth() + 1, d: jul.getUTCDate() };
}

function dayOfYear(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000);
}
function fromDayOfYear(y: number, n: number): { m: number; d: number } {
  const dt = new Date(Date.UTC(y, 0, 1) + n * 86400000);
  return { m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
const key = (m: number, d: number) => `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// ─────────────────────────────────────────────────────────────────────────────
// Εορτολόγιο. Κάθε εγγραφή: ημερομηνία → ονόματα (στη μορφή που θα γραφτεί στο SMS).
// Περιλαμβάνονται μόνο παραλλαγές/υποκοριστικά με ΜΟΝΟΣΗΜΑΝΤΗ αντιστοίχιση
// (π.χ. Βίκυ→Βασιλική, Σόνια→Σοφία). Αμφίσημα (Έφη, Νανά, Σούλα, Λίτσα, Τίνα,
// Λίνα, Βούλα, Νίκη, Αθηνά…) μένουν σκόπιμα εκτός.
// ─────────────────────────────────────────────────────────────────────────────
const FIXED: Record<string, string[]> = {
  '01-01': ['Βασίλειος', 'Βασίλης', 'Βασιλική', 'Βίκυ', 'Βάσω', 'Βάσια', 'Βασούλα', 'Βασιλεία', 'Αιμιλία'],
  '01-06': ['Θεοφάνης', 'Φάνης', 'Θεοφανία', 'Φανή', 'Φώτιος', 'Φώτης', 'Ουρανία', 'Ράνια', 'Ιορδάνης'],
  '01-07': ['Ιωάννης', 'Γιάννης', 'Ιωάννα', 'Γιάννα', 'Γιαννούλα', 'Γιόχαν'],
  '01-11': ['Θεοδόσιος'],
  '01-12': ['Τατιανή', 'Τατιάνα', 'Τάνια'],
  '01-17': ['Αντώνιος', 'Αντώνης', 'Αντωνία', 'Τόνια'],
  '01-18': ['Αθανάσιος', 'Θανάσης', 'Θάνος', 'Αθανασία', 'Νάσια', 'Κύριλλος'],
  '01-20': ['Ευθύμιος', 'Θύμιος', 'Ευθυμία'],
  '01-21': ['Μάξιμος', 'Αγνή', 'Νεόφυτος'],
  '01-22': ['Τιμόθεος'],
  '01-24': ['Ξένια', 'Ξένη'],
  '01-25': ['Γρηγόριος', 'Γρηγόρης'],
  '01-27': ['Χρυσόστομος'],
  '01-31': ['Ευδοξία'],
  '02-01': ['Τρύφων', 'Τρύφωνας'],
  '02-02': ['Υπαπαντή'],
  '02-03': ['Συμεών', 'Σίμος'],
  '02-05': ['Αγάθη', 'Αγαθή'],
  '02-10': ['Χαράλαμπος', 'Μπάμπης', 'Χάρης', 'Χαραλαμπία', 'Χαρά', 'Χάρις', 'Χαρίκλεια'],
  '02-11': ['Βλάσιος', 'Βλάσης', 'Βλασία', 'Θεοδώρα', 'Δώρα', 'Ντόρα'],
  '02-13': ['Χλόη'],
  '02-23': ['Πολύκαρπος'],
  '02-26': ['Φωτεινή', 'Φαίη', 'Φωτούλα'],
  '03-01': ['Ευδοκία'],
  '03-09': ['Σαράντης', 'Σαράντος'],
  '03-17': ['Αλέξιος', 'Αλέξης', 'Αλεξία'],
  '03-19': ['Χρύσανθος', 'Χρυσάνθη'],
  '03-25': ['Ευάγγελος', 'Βαγγέλης', 'Ευαγγελία', 'Εύα', 'Βαγγελιώ'],
  '04-06': ['Ευτύχιος', 'Ευτυχία'],
  '04-29': ['Ιάσων', 'Ιάσονας'],
  '05-04': ['Μόνικα'],
  '05-05': ['Ειρήνη', 'Ρένα', 'Ειρηναίος', 'Ρηνιώ', 'Ρηνούλα'],
  '05-09': ['Χριστόφορος'],
  '05-13': ['Γλυκερία'],
  '05-14': ['Ισίδωρος', 'Ισιδώρα'],
  '05-15': ['Αχίλλειος', 'Αχιλλέας'],
  '05-20': ['Λυδία'],
  '05-21': ['Κωνσταντίνος', 'Κώστας', 'Ντίνος', 'Κωνσταντίνα', 'Ντίνα', 'Κωνσταντία', 'Ελένη', 'Έλενα', 'Ελένα', 'Λένα', 'Ελεάνα', 'Έλλη', 'Ελίνα', 'Λενιώ'],
  '05-29': ['Θεοδοσία'],
  '06-04': ['Μάρθα'],
  '06-05': ['Δωρόθεος', 'Δωροθέα'],
  '06-08': ['Καλλιόπη'],
  '06-10': ['Αντωνίνα'],
  '06-11': ['Βαρθολομαίος', 'Βαρνάβας'],
  '06-29': ['Πέτρος', 'Παύλος', 'Παυλίνα'],
  '07-01': ['Κοσμάς', 'Δαμιανός', 'Ανάργυρος'],
  '07-07': ['Κυριακή', 'Κυριάκος'],
  '07-08': ['Προκόπιος', 'Προκόπης', 'Προκοπία'],
  '07-11': ['Όλγα'],
  '07-12': ['Βερονίκη'],
  '07-15': ['Κήρυκος', 'Ιουλίτα'],
  '07-17': ['Μαρίνα', 'Μαργαρίτα'],
  '07-20': ['Ηλίας', 'Ηλιάνα', 'Ηλιάννα'],
  '07-22': ['Μαγδαληνή', 'Μάγδα', 'Μαρκέλλα', 'Μαρκέλα'],
  '07-24': ['Χριστίνα', 'Χριστιάνα', 'Χριστιάννα'],
  '07-25': ['Ολυμπία'],
  '07-26': ['Παρασκευή'],
  '07-27': ['Παντελεήμων', 'Παντελής'],
  '08-06': ['Σωτήριος', 'Σωτήρης', 'Σωτηρία'],
  '08-15': ['Μαρία', 'Μαίρη', 'Μάρω', 'Μαριώ', 'Μαρίκα', 'Μαριέττα', 'Μάρα', 'Μάνια', 'Μαριάννα', 'Μαριάνα', 'Μαριλένα', 'Μαριάνθη', 'Μαρίτα', 'Μαριτίνα', 'Μαριάμ', 'Μάριος',
           'Παναγιώτης', 'Πάνος', 'Παναγιώτα', 'Γιώτα', 'Δέσποινα', 'Ντέπη'],
  '08-26': ['Αδριανός', 'Ναταλία', 'Ναταλί', 'Ανδριάνα', 'Ανδριανή', 'Αδριανή'],
  '08-27': ['Φανούριος', 'Φανούρης'],
  '08-30': ['Αλέξανδρος', 'Αλέκος', 'Αλεξάνδρα', 'Αλέκα'],
  '09-03': ['Φοίβη'],
  '09-04': ['Ερμιόνη'],
  '09-05': ['Ζαχαρίας', 'Ελισάβετ', 'Ελισσάβετ', 'Έλσα'],
  '09-13': ['Κορνήλιος', 'Κορνηλία'],
  '09-14': ['Σταύρος', 'Σταυρούλα', 'Σταυρία'],
  '09-15': ['Νικήτας'],
  '09-16': ['Ευφημία'],
  '09-17': ['Σοφία', 'Σόνια', 'Σοφούλα', 'Πίστη', 'Ελπίδα', 'Αγάπη'],
  '09-18': ['Αριάδνη', 'Ευμένιος'],
  '09-20': ['Ευστάθιος', 'Στάθης', 'Ευσταθία'],
  '09-22': ['Φωκάς'],
  '09-23': ['Ξανθίππη', 'Ξανθή', 'Πολυξένη'],
  '09-24': ['Θέκλα', 'Μυρτώ'],
  '09-25': ['Ευφροσύνη', 'Φρόσω'],
  '10-01': ['Ρωμανός'],
  '10-03': ['Διονύσιος', 'Διονύσης', 'Διονυσία'],
  '10-06': ['Θωμάς', 'Θωμαή'],
  '10-07': ['Σέργιος', 'Πολυχρόνης'],
  '10-08': ['Πελαγία'],
  '10-13': ['Χρυσή', 'Χρύσα', 'Χρυσούλα'],
  '10-18': ['Λουκάς'],
  '10-20': ['Αρτέμιος', 'Άρτεμις', 'Γεράσιμος', 'Ματρώνα'],
  '10-23': ['Ιάκωβος'],
  '10-26': ['Δημήτριος', 'Δημήτρης', 'Μίμης', 'Δήμος', 'Δήμητρα', 'Δημητρούλα', 'Δημητρία', 'Στέργιος'],
  '11-01': ['Κοσμάς', 'Δαμιανός', 'Ανάργυρος', 'Αργύρης', 'Αργυρώ'],
  '11-08': ['Μιχαήλ', 'Μιχάλης', 'Μιχαέλα', 'Μιχαλίτσα', 'Γαβριήλ', 'Γαβριέλα', 'Άγγελος', 'Αγγελική', 'Αγγέλα', 'Άντζελα', 'Αγγελίνα', 'Αγγελίτσα',
           'Σταμάτης', 'Σταματία', 'Σταματίνα', 'Ματίνα', 'Ταξιάρχης'],
  '11-09': ['Νεκτάριος', 'Νεκταρία'],
  '11-11': ['Μηνάς', 'Βίκτωρ', 'Βίκτορας', 'Βικτωρία', 'Βικτώρια'],
  '11-14': ['Φίλιππος', 'Φιλίππα'],
  '11-16': ['Ματθαίος'],
  '11-25': ['Αικατερίνη', 'Κατερίνα', 'Καίτη', 'Κάτια', 'Κατίνα', 'Κατερινιώ', 'Μερκούριος'],
  '11-26': ['Στυλιανός', 'Στέλιος', 'Στυλιανή', 'Στέλλα'],
  '11-30': ['Ανδρέας'],
  '12-04': ['Βαρβάρα', 'Σεραφείμ'],
  '12-05': ['Σάββας'],
  '12-06': ['Νικόλαος', 'Νίκος', 'Νικολέτα', 'Νικολέττα', 'Νικολίνα', 'Νικολία', 'Νικολίτσα'],
  '12-09': ['Άννα', 'Αννέτα'],
  '12-12': ['Σπυρίδων', 'Σπύρος', 'Σπυριδούλα'],
  '12-13': ['Ευστράτιος', 'Στράτος', 'Λουκία'],
  '12-15': ['Ελευθέριος', 'Λευτέρης', 'Ελευθερία', 'Ανθία', 'Άνθη'],
  '12-17': ['Δανιήλ', 'Δανιέλα', 'Δανάη'],
  '12-18': ['Σεβαστιανός', 'Σεβαστή'],
  '12-19': ['Αγλαΐα'],
  '12-20': ['Ιγνάτιος'],
  '12-24': ['Ευγενία'],
  '12-25': ['Χρήστος', 'Εμμανουήλ', 'Μανώλης', 'Μανόλης', 'Μάνος', 'Εμμανουέλα', 'Εμμανουέλλα'],
  '12-27': ['Στέφανος', 'Στεφανία'],
};

// Λατινικές μορφές που ΔΕΝ προκύπτουν από απλή μεταγραφή αλλά είναι το ίδιο όνομα.
const LATIN_ALIASES: Record<string, string> = {
  ZOE: 'Ζωή', CHLOE: 'Χλόη', IRENE: 'Ειρήνη', IRENA: 'Ειρήνη', CATHERINE: 'Κατερίνα', KATHERINE: 'Κατερίνα',
  ELIZABETH: 'Ελισάβετ', ELISABETH: 'Ελισάβετ', MICHAEL: 'Μιχαήλ', ELIAS: 'Ηλίας', DEMETRA: 'Δήμητρα',
  DEMETRIOS: 'Δημήτριος', DEMETRIA: 'Δημητρία', DANAE: 'Δανάη', ARIADNE: 'Αριάδνη', RAPHAEL: 'Ραφαήλ',
  GABRIEL: 'Γαβριήλ', DANIEL: 'Δανιήλ', AGATHA: 'Αγάθη', JOHANN: 'Γιόχαν', JOHAN: 'Γιόχαν', YOHAN: 'Γιόχαν',
  CONSTANTINE: 'Κωνσταντίνος', EUGENIA: 'Ευγενία', VICKY: 'Βίκυ', VIKKY: 'Βίκυ', SOPHIE: 'Σοφία',
};

// Κινητές εορτές: offset σε ημέρες από την Κυριακή του Πάσχα.
function movableFeasts(year: number): Record<string, string[]> {
  const E = orthodoxEaster(year);
  const eDoy = dayOfYear(year, E.m, E.d);
  const at = (offset: number) => { const p = fromDayOfYear(year, eDoy + offset); return key(p.m, p.d); };
  const out: Record<string, string[]> = {};
  const add = (k: string, names: string[]) => { out[k] = (out[k] || []).concat(names); };
  add(at(-43), ['Θεόδωρος', 'Θοδωρής', 'Θόδωρος']);                 // Σάββατο των Θεοδώρων
  add(at(-8), ['Λάζαρος']);                                            // Σάββατο του Λαζάρου
  add(at(-7), ['Βάιος', 'Βάια', 'Βάγια', 'Δάφνη']);                    // Κυριακή των Βαΐων
  add(at(0), ['Αναστάσιος', 'Τάσος', 'Αναστασία', 'Τασία', 'Νατάσα', 'Νατάσσα', 'Λάμπρος', 'Λαμπρινή', 'Λάμπρω', 'Πασχάλης', 'Πασχαλιά']);
  // Άγιος Γεώργιος: 23/4, εκτός αν πέφτει πριν ή την Κυριακή του Πάσχα → Δευτέρα του Πάσχα.
  const g = dayOfYear(year, 4, 23) <= eDoy ? at(1) : key(4, 23);
  add(g, ['Γεώργιος', 'Γιώργος', 'Γεωργία', 'Γωγώ']);
  // Άγιος Μάρκος: 25/4, εκτός αν πέφτει έως τη Δευτέρα του Πάσχα → Τρίτη του Πάσχα.
  const mk = dayOfYear(year, 4, 25) <= eDoy + 1 ? at(2) : key(4, 25);
  add(mk, ['Μάρκος']);
  add(at(2), ['Ραφαήλ', 'Ραφαέλα', 'Ραφαηλία']);                       // Τρίτη της Διακαινησίμου
  add(at(5), ['Ζωή', 'Ζωίτσα', 'Πηγή']);                               // Ζωοδόχου Πηγής
  return out;
}

function namesForDate(y: number, m: number, d: number): string[] {
  const k = key(m, d);
  const list = (FIXED[k] || []).concat(movableFeasts(y)[k] || []);
  return Array.from(new Set(list));
}

// ─────────────────────────────────────────────────────────────────────────────
// Κανονικοποίηση ονομάτων → «σκελετός» κοινός για ελληνικά και greeklish.
// Σοφία / ΣΟΦΙΑ / Sofia / Sophia → 'sofia'. Ίση σύγκριση μόνο (όχι prefix/fuzzy).
// ─────────────────────────────────────────────────────────────────────────────
const GREEK_DIGRAPHS: Array<[string, string]> = [
  ['ου', 'u'], ['αι', 'e'], ['ει', 'i'], ['οι', 'i'], ['υι', 'i'], ['αυ', 'af'], ['ευ', 'ef'], ['ηυ', 'if'],
  ['γγ', 'g'], ['γκ', 'g'], ['μπ', 'b'], ['ντ', 'd'],
];
const GREEK_SINGLE: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'T', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x',
  ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'i', φ: 'f', χ: 'x', ψ: 'ps', ω: 'o',
};
const LATIN_RULES: Array<[RegExp, string]> = [
  [/th/g, 'T'], [/ph/g, 'f'], [/ch/g, 'x'], [/kh/g, 'x'], [/sh/g, 's'],
  [/ou/g, 'u'], [/ei/g, 'i'], [/ai/g, 'e'], [/oi/g, 'i'], [/au/g, 'af'], [/eu/g, 'ef'],
  [/y(?=[aeiou])/g, 'gi'], [/y/g, 'i'], [/j/g, 'i'], [/w/g, 'v'], [/c/g, 'k'], [/q/g, 'k'], [/h/g, 'x'],
  [/ng/g, 'g'], [/gk/g, 'g'], [/nt/g, 'd'], [/mp/g, 'b'], [/mb/g, 'b'], [/b/g, 'v'], [/v/g, 'f'],
  [/(.)\1+/g, '$1'],
];

function skeleton(input: string): string {
  let s = (input || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zα-ω]/g, '');
  for (const [g, l] of GREEK_DIGRAPHS) s = s.split(g).join(l);
  s = s.replace(/[α-ω]/g, (ch) => GREEK_SINGLE[ch] || '');
  for (const [re, rep] of LATIN_RULES) s = s.replace(re, rep);
  return s;
}

// Λεξικό (skeleton → εμφανιζόμενη μορφή) για ΟΛΟ το εορτολόγιο — χρησιμεύει
// για να γράψουμε σωστά (με τόνους) και τα μέρη διπλών ονομάτων (Άννα-Μαρία).
const ALL_DISPLAY: Record<string, string> = {};
for (const names of Object.values(FIXED)) for (const n of names) ALL_DISPLAY[skeleton(n)] = ALL_DISPLAY[skeleton(n)] || n;
for (const names of Object.values(movableFeasts(2026))) for (const n of names) ALL_DISPLAY[skeleton(n)] = ALL_DISPLAY[skeleton(n)] || n;
for (const [latin, gr] of Object.entries(LATIN_ALIASES)) ALL_DISPLAY[skeleton(latin)] = ALL_DISPLAY[skeleton(latin)] || gr;

function titleCase(s: string): string {
  const low = s.toLowerCase();
  return low ? low[0].toUpperCase() + low.slice(1) : '';
}

// Μικρό όνομα από το full_name: ό,τι προηγείται του πρώτου κενού ή της «(».
// Επιστρέφει τα «μέρη» (για διπλά ονόματα με παύλα) + το επώνυμο (μόνο για τον πίνακα).
function splitName(fullName: string): { first: string; parts: string[]; last: string } {
  const clean = (fullName || '').replace(/\(.*$/, '').replace(/\s+/g, ' ').trim();
  const tokens = clean.split(' ');
  let first = (tokens.shift() || '').replace(/[.,;:]+$/g, '');
  // «ΚΩΝ/ΝΑ», «ΚΩΝ/ΝΟΣ» = Κωνσταντίνα/Κωνσταντίνος
  if (/^ΚΩΝ\/Ν(Α|ΟΣ)$/i.test(first)) first = first.toUpperCase() === 'ΚΩΝ/ΝΑ' ? 'Κωνσταντίνα' : 'Κωνσταντίνος';
  const parts = first.split(/[-–—/]/).map((p) => p.trim()).filter((p) => p.length >= 2 && !/\./.test(p));
  return { first, parts, last: tokens.join(' ') };
}

interface Match { display: string; feast: string }

// Ταιριάζει το μικρό όνομα με τα σημερινά ονόματα. Επιστρέφει το όνομα όπως
// θα γραφτεί στο SMS (με τόνους, από το εορτολόγιο) και το όνομα της εορτής.
function matchName(fullName: string, todayIndex: Map<string, string>): Match | null {
  const { parts } = splitName(fullName);
  if (!parts.length) return null;
  let feast: string | null = null;
  const display: string[] = [];
  for (const p of parts) {
    const sk = skeleton(p);
    const aliasHit = LATIN_ALIASES[p.toUpperCase()];
    const hit = todayIndex.get(sk) || (aliasHit && todayIndex.get(skeleton(aliasHit))) || null;
    if (hit && !feast) feast = hit;
    display.push(hit || ALL_DISPLAY[sk] || (aliasHit ? aliasHit : titleCase(p)));
  }
  if (!feast) return null;
  return { display: display.join('-'), feast };
}

function buildTodayIndex(names: string[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const n of names) { const sk = skeleton(n); if (!idx.has(sk)) idx.set(sk, n); }
  return idx;
}

function renderTemplate(template: string, name: string, clinic: string): string {
  return (template || DEFAULT_TEMPLATE)
    .replace(/\{name\}|\[Μικρό Όνομα\]|\[Όνομα\]/gi, name)
    .replace(/\{clinic\}|\[Όνομα Οργανισμού\]|\[Οργανισμός\]/gi, clinic)
    .replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS (Apifon) — ίδια υλοποίηση με appointment-automations, με προαιρετικό sender_id.
// ─────────────────────────────────────────────────────────────────────────────
function normalizeSmsPhone(phone: string | undefined | null): string | null {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0030') && digits.length === 14) return digits.slice(2);
  if (digits.startsWith('30') && digits.length === 12 && digits.startsWith('306')) return digits;
  if (digits.length === 10 && digits.startsWith('69')) return '30' + digits;
  return null; // μόνο ελληνικά κινητά — ό,τι άλλο θεωρείται μη έγκυρο κινητό
}

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  let bin = '';
  new Uint8Array(sig).forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

const APIFON_SMS_PATH = '/services/api/v1/sms/send';

async function sendSms(to: string, message: string, senderOverride?: string | null): Promise<{ ok: boolean; error?: string; providerId?: string }> {
  const token = Deno.env.get('APIFON_TOKEN');
  const apiKey = Deno.env.get('APIFON_API_KEY');
  if (!token || !apiKey) return { ok: false, error: 'not_configured' };
  const senderId = (senderOverride || '').trim() || Deno.env.get('APIFON_SENDER_ID') || 'BeautyLine';
  const body = JSON.stringify({
    subscribers: [{ number: to }],
    message: { text: message, sender_id: senderId, dc: 2 }, // dc:2 = UCS-2 για ελληνικά με τόνους
  });
  const date = new Date().toUTCString();
  const signature = await hmacSha256Base64(apiKey, ['POST', APIFON_SMS_PATH, body, date].join('\n'));
  try {
    const res = await fetch('https://ars.apifon.com' + APIFON_SMS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ApifonWS-Date': date, Authorization: `ApifonWS ${token}:${signature}` },
      body,
    });
    const out = await res.json();
    if (!res.ok || !out.result_info || out.result_info.status_code !== 200) return { ok: false, error: JSON.stringify(out) };
    const results = out.results && out.results[to];
    return { ok: true, providerId: results && results[0] && results[0].message_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Λογική ανά κλινική
// ─────────────────────────────────────────────────────────────────────────────
interface NamedaySettings {
  enabled: boolean; approval_required: boolean; auto_send: boolean;
  template: string | null; org_name: string | null; send_hour: number; sender_id: string | null;
}
interface ClinicRow { id: string; name: string; settings: Record<string, unknown> | null }

function readSettings(c: ClinicRow): NamedaySettings {
  const s = ((c.settings || {}) as Record<string, unknown>).nameday_sms as Partial<NamedaySettings> | undefined;
  return {
    enabled: !!(s && s.enabled),
    approval_required: s && s.approval_required === false ? false : true,
    auto_send: !!(s && s.auto_send),
    template: (s && typeof s.template === 'string' && s.template.trim()) ? s.template : null,
    org_name: (s && typeof s.org_name === 'string' && s.org_name.trim()) ? s.org_name.trim() : null,
    send_hour: s && Number.isInteger(s.send_hour) ? Number(s.send_hour) : 10,
    sender_id: (s && typeof s.sender_id === 'string' && s.sender_id.trim()) ? s.sender_id.trim() : null,
  };
}

// Όνομα οργανισμού στο SMS: ρύθμιση → brand_name (πριν το «by») → όνομα κλινικής (πριν το «by»).
function orgName(c: ClinicRow, s: NamedaySettings): string {
  if (s.org_name) return s.org_name;
  const brand = String(((c.settings || {}) as Record<string, unknown>).brand_name || '').trim();
  const base = brand || c.name || '';
  return (base.split(/\s+by\s+/i)[0] || base).trim();
}

interface PreviewRow {
  patient_id: string; first_name: string; last_name: string; feast: string;
  phone: string | null; phone_normalized: string | null; message: string;
  status: 'ready' | 'sent' | 'failed' | 'pending' | 'no_mobile' | 'duplicate_phone';
  sent_at?: string | null; error?: string | null;
}

// deno-lint-ignore no-explicit-any
type Sb = any;

async function buildPreview(sb: Sb, clinic: ClinicRow, dateIso: string) {
  const s = readSettings(clinic);
  const [y, m, d] = dateIso.split('-').map(Number);
  const names = namesForDate(y, m, d);
  const org = orgName(clinic, s);
  const template = s.template || DEFAULT_TEMPLATE;
  const rows: PreviewRow[] = [];
  if (names.length) {
    const idx = buildTodayIndex(names);
    const { data: patients, error } = await sb.from('patients').select('id, full_name, phone, status')
      .eq('clinic_id', clinic.id).neq('status', 'inactive').order('full_name');
    if (error) throw new Error(error.message);
    const { data: logs } = await sb.from('nameday_sms_log').select('patient_id, status, sent_at, error')
      .eq('clinic_id', clinic.id).eq('nameday_date', dateIso);
    const logByPatient = new Map<string, { status: string; sent_at: string | null; error: string | null }>();
    for (const l of logs || []) logByPatient.set(l.patient_id, l);
    const seenPhones = new Set<string>();
    for (const p of patients || []) {
      const mt = matchName(p.full_name || '', idx);
      if (!mt) continue;
      const { last } = splitName(p.full_name || '');
      const norm = normalizeSmsPhone(p.phone);
      const message = renderTemplate(template, mt.display, org);
      let status: PreviewRow['status'] = 'ready';
      const log = logByPatient.get(p.id);
      if (!norm) status = 'no_mobile';
      else if (seenPhones.has(norm)) status = 'duplicate_phone';
      else if (log && log.status === 'sent') status = 'sent';
      else if (log && log.status === 'pending') status = 'pending';
      else if (log && log.status === 'failed') status = 'failed';
      if (norm && status !== 'duplicate_phone') seenPhones.add(norm);
      rows.push({
        patient_id: p.id, first_name: mt.display, last_name: last, feast: mt.feast,
        phone: p.phone || null, phone_normalized: norm, message, status,
        sent_at: log ? log.sent_at : null, error: log ? log.error : null,
      });
    }
  }
  const counts = { total: rows.length, ready: 0, sent: 0, failed: 0, pending: 0, no_mobile: 0, duplicate_phone: 0 };
  for (const r of rows) counts[r.status]++;
  return { ok: true, enabled: s.enabled, date: dateIso, names, org_name: org, template, settings: s, rows, counts };
}

async function runSend(sb: Sb, clinic: ClinicRow, dateIso: string, patientIds: string[] | null, sentBy: string | null) {
  const pv = await buildPreview(sb, clinic, dateIso);
  const s = pv.settings;
  const wanted = new Set(patientIds || []);
  const targets = pv.rows.filter((r) => (r.status === 'ready' || r.status === 'failed') && (!patientIds || wanted.has(r.patient_id)));
  const result = { ok: true, date: dateIso, attempted: 0, sent: 0, failed: 0, skipped_already_sent: 0, errors: [] as Array<{ patient_id: string; error: string }> };
  for (const r of targets) {
    result.attempted++;
    // Κλείδωμα ημέρας: η unique εγγραφή εξασφαλίζει ότι δεν φεύγει διπλό SMS
    // ακόμη κι αν δύο χρήστες πατήσουν «Αποστολή» ταυτόχρονα.
    let logId: string | null = null;
    const ins = await sb.from('nameday_sms_log').insert({
      clinic_id: clinic.id, patient_id: r.patient_id, nameday_date: dateIso, feast_name: r.feast,
      first_name: r.first_name, phone: r.phone_normalized, template: pv.template, message: r.message,
      status: 'pending', sent_by: sentBy,
    }).select('id').single();
    if (ins.error) {
      if (ins.error.code === '23505') {
        // Υπάρχει ήδη εγγραφή: επανάληψη επιτρέπεται ΜΟΝΟ αν είχε αποτύχει.
        const upd = await sb.from('nameday_sms_log').update({ status: 'pending', error: null, sent_by: sentBy, message: r.message, phone: r.phone_normalized })
          .eq('clinic_id', clinic.id).eq('patient_id', r.patient_id).eq('nameday_date', dateIso).eq('status', 'failed').select('id');
        if (upd.error || !upd.data || !upd.data.length) { result.skipped_already_sent++; result.attempted--; continue; }
        logId = upd.data[0].id;
      } else {
        result.failed++; result.errors.push({ patient_id: r.patient_id, error: ins.error.message }); continue;
      }
    } else logId = ins.data.id;

    const sr = await sendSms(r.phone_normalized as string, r.message, s.sender_id);
    const now = new Date().toISOString();
    await sb.from('nameday_sms_log').update({
      status: sr.ok ? 'sent' : 'failed', provider_message_id: sr.providerId || null, error: sr.ok ? null : (sr.error || 'send_failed'),
      sent_at: sr.ok ? now : null,
    }).eq('id', logId);
    await sb.from('sms_log').insert({
      clinic_id: clinic.id, patient_id: r.patient_id, sms_type: 'nameday', phone: r.phone_normalized, message: r.message,
      status: sr.ok ? 'sent' : 'failed', sent_at: sr.ok ? now : null, error: sr.ok ? null : (sr.error || null),
    });
    if (sr.ok) result.sent++; else { result.failed++; result.errors.push({ patient_id: r.patient_id, error: sr.error || 'send_failed' }); }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const secret = Deno.env.get('BIRTHDAY_CRON_SECRET');
  const isCron = !!secret && req.headers.get('x-cron-secret') === secret;
  let body: { action?: string; clinic_id?: string; date?: string; patient_ids?: string[]; phone?: string; first_name?: string } = {};
  try { body = await req.json(); } catch { /* κενό body από cron */ }

  let user: { id: string; role: string; clinic_id: string | null } | null = null;
  if (!isCron) {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user: u } } = await userClient.auth.getUser();
    if (!u) return json({ error: 'Unauthorized' }, 401);
    const { data: profile } = await sb.from('profiles').select('role, clinic_id, active').eq('id', u.id).single();
    if (!profile || profile.active === false) return json({ error: 'Forbidden' }, 403);
    user = { id: u.id, role: profile.role, clinic_id: profile.clinic_id };
  }

  const today = athensParts();
  const dateIso = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? (body.date as string) : today.iso;

  try {
    // ── Cron: μόνο κλινικές με enabled + auto_send, την ώρα send_hour (Αθήνα) ──
    if (isCron && !body.action) {
      const { data: clinics } = await sb.from('clinics').select('id, name, settings').eq('active', true);
      const out: Record<string, unknown> = {};
      for (const c of (clinics || []) as ClinicRow[]) {
        const s = readSettings(c);
        if (!s.enabled || !s.auto_send || s.send_hour !== today.hour) continue;
        out[c.id] = await runSend(sb, c, today.iso, null, null);
      }
      return json({ ok: true, date: today.iso, hour: today.hour, clinics: out });
    }

    if (body.action === 'calendar') {
      const [y, m, d] = dateIso.split('-').map(Number);
      return json({ ok: true, date: dateIso, names: namesForDate(y, m, d) });
    }

    // ── Ενέργειες ανά κλινική: ο χρήστης πρέπει να ανήκει στην κλινική (ή super_admin) ──
    const clinicId = body.clinic_id;
    if (!clinicId) return json({ error: 'clinic_id required' }, 400);
    if (user && user.role !== 'super_admin' && user.clinic_id !== clinicId) return json({ error: 'Forbidden' }, 403);
    const { data: clinic } = await sb.from('clinics').select('id, name, settings').eq('id', clinicId).single();
    if (!clinic) return json({ error: 'clinic not found' }, 404);
    const s = readSettings(clinic as ClinicRow);

    if (body.action === 'preview') {
      if (!s.enabled) return json({ ok: false, enabled: false, date: dateIso, names: [], rows: [], counts: { total: 0 } });
      return json(await buildPreview(sb, clinic as ClinicRow, dateIso));
    }

    if (body.action === 'send' || body.action === 'test_send') {
      if (!s.enabled) return json({ ok: false, enabled: false, error: 'nameday_sms_disabled' }, 403);
      if (user && !['super_admin', 'clinic_admin', 'receptionist'].includes(user.role)) return json({ error: 'Forbidden' }, 403);
    }

    if (body.action === 'test_send') {
      const to = normalizeSmsPhone(body.phone);
      if (!to) return json({ ok: false, error: 'invalid_phone' }, 400);
      const name = (body.first_name || '').trim() || 'Μαρία';
      const message = renderTemplate(s.template || DEFAULT_TEMPLATE, name, orgName(clinic as ClinicRow, s));
      const sr = await sendSms(to, message, s.sender_id);
      await sb.from('sms_log').insert({
        clinic_id: clinicId, sms_type: 'nameday', phone: to, message, status: sr.ok ? 'sent' : 'failed',
        sent_at: sr.ok ? new Date().toISOString() : null, error: sr.ok ? null : (sr.error || null),
      });
      return json({ ok: sr.ok, message, provider_id: sr.providerId || null, error: sr.error || null });
    }

    if (body.action === 'send') {
      const ids = Array.isArray(body.patient_ids) && body.patient_ids.length ? body.patient_ids.map(String) : null;
      // Η χειροκίνητη αποστολή αφορά πάντα τη σημερινή ημέρα (Αθήνα) — όχι παλιές ημερομηνίες.
      return json(await runSend(sb, clinic as ClinicRow, today.iso, ids, user ? user.id : null));
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
