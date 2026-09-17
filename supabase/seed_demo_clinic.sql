-- ============================================================================
-- DEMO CLINIC — εικονικά δεδομένα επίδειξης
-- ============================================================================
-- Γεμίζει την κλινική demo (id a787b766-…) με ΠΛΗΡΩΣ εικονικά δεδομένα ενός
-- ΔΕΡΜΑΤΟΛΟΓΙΚΟΥ ιατρείου, ώστε να μπορεί να παρουσιαστεί το CRM σε υποψήφιο
-- πελάτη: 2 δερματολόγοι + αισθητικός + νοσηλεύτρια laser με ωράριο/άδειες,
-- κατάλογο υπηρεσιών (ιατρική δερματολογία, ενέσιμες, laser & συσκευές,
-- peelings), 60 ασθενείς (με ΑΜΚΑ), ~2.500 ραντεβού 14 μηνών, συναινέσεις
-- κάθε τύπου, consultations, laser forms & πακέτα, πωλήσεις προϊόντων,
-- αυτοματισμούς επικοινωνίας, δώρα γενεθλίων, pipeline.
--
-- ΕΠΑΝΕΚΤΕΛΕΣΙΜΟ: σβήνει πρώτα ό,τι υπάρχει για τη demo κλινική και ξαναχτίζει.
-- Αγγίζει ΜΟΝΟ γραμμές με clinic_id της demo· η Beauty Line δεν επηρεάζεται
-- (από αυτήν διαβάζει μόνο τη λίστα προϊόντων περιποίησης για τα consultations).
--
-- Ασφάλεια αποστολών: οι αυτοματισμοί (appointment-automations, birthday-emails,
-- daily-schedule-email) τρέχουν ΜΟΝΟ για την κλινική «Beauty Line», οπότε τα
-- εικονικά email (@example.com) και τηλέφωνα δεν λαμβάνουν ποτέ τίποτα.
--
-- Μέσα (φωτογραφίες/εξετάσεις): το script γράφει ένα «manifest» στο
-- backup.demo_media_manifest· τα αρχεία τα δημιουργεί και ανεβάζει στο Storage
-- η edge function tmp-demo-media (βλ. supabase/functions/tmp-demo-media).
--
-- Λογαριασμοί προσωπικού demo (email / κωδικός): *@demo-clinic.gr / Demo2026!
-- ============================================================================

do $seed$
declare
  demo uuid := 'a787b766-9d23-45b2-9660-7bb480856a1b';
  bl   uuid := '9e5f4495-ca91-449a-9f87-2ddadb439a77';
  today date := (now() at time zone 'Europe/Athens')::date;
  tz text := 'Europe/Athens';

  -- Προσωπικό (σταθερά ids ώστε το script να είναι επανεκτελέσιμο)
  s_admin uuid := 'd0000000-0000-4000-8000-000000000001';
  s_maria uuid := 'd0000000-0000-4000-8000-000000000002';
  s_sofia uuid := 'd0000000-0000-4000-8000-000000000003';
  s_nikos uuid := 'd0000000-0000-4000-8000-000000000004';
  s_niki  uuid := 'd0000000-0000-4000-8000-000000000005';
  bl_settings jsonb;

  sig text := 'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22110%22 viewBox=%220 0 320 110%22><path d=%22M18 78 C 40 18, 62 22, 84 66 S 124 96, 146 52 S 186 16, 206 58 S 246 88, 300 38%22 fill=%22none%22 stroke=%22%231a237e%22 stroke-width=%223%22 stroke-linecap=%22round%22/><path d=%22M150 92 L 290 92%22 stroke=%22%23999%22 stroke-width=%221%22/></svg>';

  gdpr_txt text := 'ΔΗΛΩΣΗ ΣΥΓΚΑΤΑΘΕΣΗΣ ΕΠΕΞΕΡΓΑΣΙΑΣ ΠΡΟΣΩΠΙΚΩΝ ΔΕΔΟΜΕΝΩΝ (Κανονισμός ΕΕ 2016/679)' || E'\n\n'
    || 'Δηλώνω ότι ενημερώθηκα από την Demo Clinic για τη συλλογή και επεξεργασία των προσωπικών μου δεδομένων '
    || '(στοιχεία επικοινωνίας, ιατρικό ιστορικό, φωτογραφικό υλικό θεραπειών) με σκοπό την παροχή υπηρεσιών αισθητικής, '
    || 'τον προγραμματισμό ραντεβού και την επικοινωνία μαζί μου (υπενθυμίσεις, οδηγίες θεραπείας). ' || E'\n\n'
    || 'Τα δεδομένα τηρούνται για 10 έτη από την τελευταία επίσκεψη και δεν διαβιβάζονται σε τρίτους χωρίς τη ρητή μου συγκατάθεση. '
    || 'Διατηρώ το δικαίωμα πρόσβασης, διόρθωσης, διαγραφής, περιορισμού και εναντίωσης, καθώς και ανάκλησης της συγκατάθεσης, '
    || 'επικοινωνώντας στο info@demo-clinic.gr.';

  names text[] := array[
    'ΜΑΡΙΑ ΠΑΠΑΔΟΠΟΥΛΟΥ','ΕΛΕΝΗ ΠΑΠΑΔΟΠΟΥΛΟΥ','ΚΑΤΕΡΙΝΑ ΟΙΚΟΝΟΜΟΥ','ΓΕΩΡΓΙΑ ΟΙΚΟΝΟΜΟΥ','ΣΟΦΙΑ ΝΙΚΟΛΑΟΥ',
    'ΔΗΜΗΤΡΑ ΓΕΩΡΓΙΟΥ','ΑΝΑΣΤΑΣΙΑ ΚΑΡΑΓΙΑΝΝΗ','ΙΩΑΝΝΑ ΑΛΕΞΙΟΥ','ΧΡΙΣΤΙΝΑ ΒΛΑΧΟΥ','ΕΥΑΓΓΕΛΙΑ ΜΑΚΡΗ',
    'ΑΓΓΕΛΙΚΗ ΠΑΠΠΑ','ΠΑΡΑΣΚΕΥΗ ΣΤΑΘΟΠΟΥΛΟΥ','ΒΑΣΙΛΙΚΗ ΔΗΜΗΤΡΙΟΥ','ΑΙΚΑΤΕΡΙΝΗ ΑΝΤΩΝΙΟΥ','ΝΙΚΟΛΕΤΑ ΛΑΜΠΡΟΠΟΥΛΟΥ',
    'ΔΕΣΠΟΙΝΑ ΧΑΤΖΗ','ΕΙΡΗΝΗ ΚΥΡΙΑΚΙΔΟΥ','ΑΘΗΝΑ ΜΙΧΑΗΛΙΔΟΥ','ΦΩΤΕΙΝΗ ΙΩΑΝΝΙΔΟΥ','ΑΛΕΞΑΝΔΡΑ ΘΕΟΔΩΡΟΥ',
    'ΜΥΡΤΩ ΠΑΝΑΓΙΩΤΟΠΟΥΛΟΥ','ΖΩΗ ΖΑΧΑΡΙΟΥ','ΕΛΕΥΘΕΡΙΑ ΣΑΜΑΡΑ','ΘΕΟΔΩΡΑ ΚΟΝΤΟΥ','ΑΡΓΥΡΩ ΡΑΠΤΗ',
    'ΣΤΥΛΙΑΝΗ ΦΩΤΙΟΥ','ΚΩΝΣΤΑΝΤΙΝΑ ΜΑΥΡΙΔΟΥ','ΡΑΦΑΕΛΑ ΚΑΛΟΓΕΡΟΠΟΥΛΟΥ','ΝΑΤΑΛΙΑ ΣΤΕΡΓΙΟΥ','ΑΝΝΑ ΔΟΥΚΑ',
    'ΜΑΡΙΑΝΝΑ ΛΙΑΚΟΥ','ΛΥΔΙΑ ΤΣΑΚΙΡΗ','ΔΑΝΑΗ ΜΠΕΚΑ','ΙΦΙΓΕΝΕΙΑ ΚΩΣΤΟΠΟΥΛΟΥ','ΝΕΦΕΛΗ ΑΝΔΡΕΟΥ',
    'ΟΛΥΜΠΙΑ ΣΠΑΝΟΥ','ΠΗΝΕΛΟΠΗ ΓΙΑΝΝΑΚΟΠΟΥΛΟΥ','ΣΤΕΛΛΑ ΚΑΡΑΜΑΝΗ','ΕΛΛΗ ΒΑΣΙΛΕΙΟΥ','ΧΑΡΑ ΤΡΙΑΝΤΑΦΥΛΛΟΥ',
    'ΕΥΑ ΜΑΝΩΛΑ','ΜΕΛΙΝΑ ΧΡΙΣΤΟΔΟΥΛΟΥ','ΦΑΙΗ ΚΑΤΣΑΡΟΥ','ΡΕΝΑ ΛΟΥΚΑ','ΤΖΕΝΗ ΠΕΤΡΟΠΟΥΛΟΥ',
    'ΒΙΚΥ ΣΩΤΗΡΙΟΥ','ΚΛΕΟΠΑΤΡΑ ΑΡΒΑΝΙΤΗ','ΝΑΝΤΙΑ ΚΟΥΤΣΟΥΜΠΑ','ΛΙΛΙΑΝ ΜΑΡΚΟΥ','ΘΑΛΕΙΑ ΧΡΥΣΟΥ',
    'ΓΙΩΡΓΟΣ ΠΑΠΑΔΟΠΟΥΛΟΣ','ΝΙΚΟΣ ΚΑΡΑΓΙΑΝΝΗΣ','ΔΗΜΗΤΡΗΣ ΒΛΑΧΟΣ','ΚΩΣΤΑΣ ΜΑΚΡΗΣ','ΑΛΕΞΑΝΔΡΟΣ ΣΤΑΘΟΠΟΥΛΟΣ',
    'ΠΑΝΑΓΙΩΤΗΣ ΠΑΠΠΑΣ','ΜΙΧΑΛΗΣ ΟΙΚΟΝΟΜΟΥ','ΣΤΕΦΑΝΟΣ ΝΙΚΟΛΑΟΥ','ΑΡΙΑΔΝΗ ΛΕΜΟΝΗ','ΒΕΡΟΝΙΚΑ ΚΑΨΑΛΗ'];
  emails text[] := array[
    'maria.papadopoulou','eleni.papadopoulou','katerina.oikonomou','georgia.oikonomou','sofia.nikolaou',
    'dimitra.georgiou','anastasia.karagianni','ioanna.alexiou','christina.vlachou','evangelia.makri',
    'aggeliki.pappa','paraskevi.stathopoulou','vasiliki.dimitriou','aikaterini.antoniou','nikoleta.lampropoulou',
    'despoina.chatzi','eirini.kyriakidou','athina.michailidou','foteini.ioannidou','alexandra.theodorou',
    'myrto.panagiotopoulou','zoi.zachariou','eleftheria.samara','theodora.kontou','argyro.rapti',
    'styliani.fotiou','konstantina.mavridou','rafaela.kalogeropoulou','natalia.stergiou','anna.douka',
    'marianna.liakou','lydia.tsakiri','danai.beka','ifigeneia.kostopoulou','nefeli.andreou',
    'olympia.spanou','pinelopi.giannakopoulou','stella.karamani','elli.vasileiou','chara.triantafyllou',
    'eva.manola','melina.christodoulou','faih.katsarou','rena.louka','tzeni.petropoulou',
    'viky.sotiriou','kleopatra.arvaniti','nadia.koutsoumpa','lilian.markou','thaleia.chrysou',
    'giorgos.papadopoulos','nikos.karagiannis','dimitris.vlachos','kostas.makris','alexandros.stathopoulos',
    'panagiotis.pappas','michalis.oikonomou','stefanos.nikolaou','ariadni.lemoni','veronika.kapsali'];
  no_email_ids int[] := array[6,14,22,30,38,46,50,54];
  lead_ids int[]     := array[47,48,53,55,57,58,59,60];
  inactive_ids int[] := array[40,41,42,43,44,45];
  cities text[]   := array['Κορωπί','Κορωπί','Κορωπί','Παιανία','Μαρκόπουλο','Σπάτα','Γλυφάδα','Βούλα','Βάρη','Λαύριο','Αγία Παρασκευή','Παλλήνη'];
  sources text[]  := array['Social','Σύσταση','Google','Σύσταση','Ταμπέλα','Social','Google','Χρυσός Οδηγός','Website','Booking'];
  conditions text[] := array['Ατοπική δερματίτιδα','Ψωρίαση (ήπια, αγκώνες)','Ροδόχρους νόσος','Υποθυρεοειδισμός','Αλλεργική ρινίτιδα','Ήπια υπέρταση','Πολυκυστικές ωοθήκες'];
  allergies_l text[] := array['Νικέλιο','Πενικιλίνη','Γύρη','Λάτεξ','Άρωμα / συντηρητικά καλλυντικών'];
  meds_l text[] := array['Ισοτρετινοΐνη 20mg (ολοκληρώθηκε 03/2025)','Levothyroxine 50mcg','Αντισυλληπτικά','Αντιισταμινικό κατά περιόδους','Βιταμίνη D 2000 IU'];
  prev_l text[] := array['Θεραπεία ακμής με ισοτρετινοΐνη (2024)','Laser αποτρίχωση σε άλλο κέντρο (2023)','Botox γλαβέλλας ×2 (2025)','Peeling γλυκολικού (2025)','Καμία προηγούμενη θεραπεία'];
  appt_notes text[] := array['Ευαίσθητο δέρμα — χαμηλή ένταση','Πρώτη επίσκεψη','Ζήτησε τον ίδιο ιατρό','Ήρθε με 10΄ καθυστέρηση','Πληρωμή με κάρτα','Να θυμίσουμε καθημερινό SPF 50','Επανεξέταση σε 6 εβδομάδες','Φωτογράφηση πριν/μετά — συναίνεση ΟΚ'];
  -- Κατηγορίες υπηρεσιών του δερματολογικού ιατρείου (δείκτες: 1 ιατρική, 2 ενέσιμες, 3 laser, 4 peelings/αισθητική)
  cats text[] := array['Ιατρική Δερματολογία','Ενέσιμες Θεραπείες','Laser & Συσκευές','Peelings & Ιατρική Αισθητική'];
  laser_prefix text := 'Laser Αποτρίχωση ';
  closed date[] := array['2025-12-25','2025-12-26','2026-01-01','2026-01-06','2026-03-25','2026-04-10','2026-04-13','2026-05-01','2026-06-01','2026-08-15','2026-10-28','2026-12-25','2026-12-26']::date[];
  skin_profiles text[] := array['Ακμή, Λιπαρότητα','Φωτογήρανση, Ρυτίδες','Μέλασμα, Δυσχρωμίες','Ροδόχρους νόσος, Ερυθρότητα','Αφυδάτωση, Ευαισθησία'];
  expected_l text[] := array['μείωση φλεγμονωδών βλαβών και λιπαρότητας, πιο ομοιόμορφη υφή','λείανση λεπτών γραμμών, βελτίωση ελαστικότητας, λάμψη','σταδιακή μείωση των κηλίδων, ομοιόμορφος τόνος (με αυστηρή φωτοπροστασία)','μείωση ερυθρότητας και εξάρσεων, ενίσχυση δερματικού φραγμού','βαθιά ενυδάτωση, ηρεμία, απαλότερη υφή'];
  step3_l text[] := array['Fractional CO2 Laser Ουλών Ακμής','IPL Φωτοανάπλαση — Πανάδες','Skin Boosters (Profhilo)','Microneedling Dermapen','TCA Peeling','PRP Προσώπου'];
  clean_l text[] := array['Medik8-Surface Radiance Cleanse – 150ml','Chantarelle-IDEAL PURE Anti-Bacterial Herbal Cleansing Gel-200 ml','Juliette Armand -Elements Sensitive Cleansing Gel- 210ml','Medik8-Lipid Balance Cleansing Oil – 140ml'];
  care_l text[] := array['Medik8-C-Tetra – 30ml','Medik8-Crystal Retinal 3 – 30ml','Juliette Armand -Elements Retinoid C Serum -20ml','Medik8-Hydra B5 – 30ml','Helixience -Brightening Dark Spot Serum-30ml','Chantarelle-RED STOP Couperose PHA Acid Day cream SPF 25 UVA/UVB -50ml'];
  prot_l text[] := array['Heliocare Ultra Gel SPF50 – 50ml','Medik8-Advanced Day Total Protect SPF 30 – 50ml','Heliocare Gel Cream Colour SPF50 – 50ml'];
  prod_price numeric[] := array[38,24,29,35,49,79,58,45,62,42,32,34,36];
  prod_l text[] := array['Medik8-Surface Radiance Cleanse – 150ml','Chantarelle-IDEAL PURE Anti-Bacterial Herbal Cleansing Gel-200 ml','Juliette Armand -Elements Sensitive Cleansing Gel- 210ml','Medik8-Lipid Balance Cleansing Oil – 140ml','Medik8-C-Tetra – 30ml','Medik8-Crystal Retinal 3 – 30ml','Juliette Armand -Elements Retinoid C Serum -20ml','Medik8-Hydra B5 – 30ml','Helixience -Brightening Dark Spot Serum-30ml','Chantarelle-RED STOP Couperose PHA Acid Day cream SPF 25 UVA/UVB -50ml','Heliocare Ultra Gel SPF50 – 50ml','Medik8-Advanced Day Total Protect SPF 30 – 50ml','Heliocare Gel Cream Colour SPF50 – 50ml'];
  consumables_l text[] := array['Βελόνα 30G','Αναισθητική κρέμα (λιδοκαΐνη)','PRP kit','Gel laser','Γάζες αποστειρωμένες','Αμπούλα Vit C','Χαρτί κρεβατιού','Μάσκα LED (μιας χρήσης)'];

  -- Ονόματα μεταβλητών επίτηδες διαφορετικά από ονόματα στηλών (status, price, i,
  -- dow…) — αλλιώς η PL/pgSQL τα θεωρεί αμφίσημα μέσα στα SQL statements.
  ii int; d date; wd int; k int; n int; r numeric;
  st record; sv record; pr record;
  t time; sched_start time; sched_end time;
  factor numeric; ahead int; dur int; gap int;
  pid uuid; aid uuid; sid uuid; svc_ids uuid[];
  start_ts timestamptz; created_ts timestamptz; a_status text; a_price numeric; a_paid numeric; a_note text;
  consult_text text; s1 text; s2 text; s3 text; skin_i int;
  ms jsonb; regions jsonb; sessions jsonb; form_id uuid; pkg_id uuid;
  photo_ts bigint; tmpl text; n_appts int := 0;
begin
  perform setseed(0.4242);

  -- ── 0. Καθαρισμός προηγούμενων δεδομένων demo ─────────────────────────────
  update appointments set package_id = null where clinic_id = demo;
  delete from appointment_consumables where clinic_id = demo;
  delete from communication_log where clinic_id = demo;
  delete from sms_log where clinic_id = demo;
  delete from birthday_gifts where clinic_id = demo;
  delete from patient_photos where clinic_id = demo;
  delete from patient_exams where clinic_id = demo;
  delete from product_sales where clinic_id = demo;
  delete from pipeline_deals where clinic_id = demo;
  delete from patient_relationships where clinic_id = demo;
  delete from patient_packages where clinic_id = demo;
  delete from laser_forms where clinic_id = demo;
  delete from medical_history_consents where clinic_id = demo;
  delete from laser_consents where clinic_id = demo;
  delete from service_consents where clinic_id = demo;
  delete from gdpr_consents where clinic_id = demo;
  delete from appointments where clinic_id = demo;
  -- Το trigger διαγραφής ραντεβού γράφει στο activity_log (με FK στον ασθενή):
  -- καθαρίζεται ΑΦΟΥ σβηστούν τα ραντεβού και ΠΡΙΝ σβηστούν οι ασθενείς.
  delete from activity_log where clinic_id = demo;
  delete from patients where clinic_id = demo;
  delete from staff_services where clinic_id = demo;
  delete from staff_schedules where clinic_id = demo;
  delete from staff_schedule_overrides where clinic_id = demo;
  delete from staff_time_off where clinic_id = demo;
  delete from service_instruction_map where clinic_id = demo;
  delete from instruction_sets where clinic_id = demo;
  delete from service_consent_templates where clinic_id = demo;
  delete from services where clinic_id = demo;
  delete from auth.users where id in (select id from profiles where clinic_id = demo)
     or id in (s_admin, s_maria, s_sofia, s_nikos, s_niki);
  -- (Τα αρχεία Storage δεν σβήνονται από SQL — η tmp-demo-media ανεβάζει με upsert,
  --  οπότε σε επανεκτέλεση απλώς αντικαθίστανται.)
  create schema if not exists backup;
  create table if not exists backup.demo_media_manifest (
    id bigserial primary key, bucket text not null, path text not null, kind text not null, params jsonb not null, uploaded_at timestamptz
  );
  delete from backup.demo_media_manifest;

  -- ── 1. Στοιχεία & ρυθμίσεις κλινικής ─────────────────────────────────────
  select settings into bl_settings from clinics where id = bl;
  update clinics set
    name = 'Demo Dermatology Clinic',
    address = 'Λεωφ. Βασιλέως Κωνσταντίνου 45, Κορωπί 194 00',
    city = 'Κορωπί',
    website = 'https://demo.medi360.gr',
    instagram = '@dermacare.demo',
    facebook = 'DermaCare Demo — Δερματολογικό Ιατρείο',
    booking_link = 'https://demo.medi360.gr/booking',
    gdpr_text = gdpr_txt,
    integrations = '{}'::jsonb,
    settings = jsonb_build_object(
      'start_hour', 9, 'end_hour', 21, 'slot_minutes', 15,
      'brand_name', 'DermaCare — Δερματολογικό Ιατρείο', 'brand_color', '#1F6F8B',
      'business_hours', jsonb_build_object(
        'schedule', jsonb_build_array(
          jsonb_build_object('day_of_week',0,'is_open',false,'start','10:00','end','18:00'),
          jsonb_build_object('day_of_week',1,'is_open',true,'start','09:00','end','21:00'),
          jsonb_build_object('day_of_week',2,'is_open',true,'start','09:00','end','21:00'),
          jsonb_build_object('day_of_week',3,'is_open',true,'start','09:00','end','21:00'),
          jsonb_build_object('day_of_week',4,'is_open',true,'start','09:00','end','21:00'),
          jsonb_build_object('day_of_week',5,'is_open',true,'start','09:00','end','21:00'),
          jsonb_build_object('day_of_week',6,'is_open',true,'start','09:00','end','15:00')),
        'closed_dates', to_jsonb(closed)),
      'enabled_modules', jsonb_build_object('sms',true,'laser',true,'reports',true,'consents',true,'product-sale',true,'consultations',true,'staff-services',true),
      'consultation_services', jsonb_build_array(
        'Χημικό Peeling Σαλικυλικού','Peeling Γλυκολικού','TCA Peeling','Microneedling Dermapen','Υδροδερμοαπόξεση',
        'Βαθύς Καθαρισμός Προσώπου — Ιατρικός','Θεραπεία Ροδόχρου Νόσου LED','Οξυγονοθεραπεία','Ενυδάτωση Υαλουρονικού',
        'Fractional CO2 Laser Ουλών Ακμής','IPL Φωτοανάπλαση — Πανάδες','Skin Boosters (Profhilo)','PRP Προσώπου',
        'Botox Μετώπου / Γλαβέλλας','Υαλουρονικό Ρινοπαρειακές','Μεσοθεραπεία Τριχωτού'),
      'consultation_products', coalesce(bl_settings->'consultation_products','{}'::jsonb),
      'service_consent_groups', jsonb_build_object(
        'Χημικό Peeling Σαλικυλικού','Peeling','Peeling Γλυκολικού','Peeling','TCA Peeling','Peeling',
        'Microneedling Dermapen','Μεσοθεραπεία','PRP Προσώπου','Μεσοθεραπεία','PRP Τριχωτού','Μεσοθεραπεία',
        'Υδροδερμοαπόξεση','Καθαρισμός Προσώπου','Βαθύς Καθαρισμός Προσώπου — Ιατρικός','Καθαρισμός Προσώπου',
        'Ενυδάτωση Υαλουρονικού','Θεραπεία Προσώπου','Οξυγονοθεραπεία','Θεραπεία Προσώπου','Θεραπεία Ροδόχρου Νόσου LED','Θεραπεία Προσώπου',
        'Laser Αποτρίχωση Άνω Χείλος','laser','Laser Αποτρίχωση Μασχάλες','laser','Laser Αποτρίχωση Πόδια Ολόκληρα','laser',
        'Laser Αποτρίχωση Μπικίνι','laser','Laser Αποτρίχωση Πρόσωπο','laser','Laser Αποτρίχωση Πλάτη Ανδρική','laser'),
      'sms_templates', jsonb_build_object(
        'booking_confirmation', jsonb_build_object('enabled',true,'text','ΤΟ ΡΑΝΤΕΒΟΥ ΣΑΣ ΣΤΟ {clinic} ΚΛΕΙΣΤΗΚΕ ΓΙΑ {date} ΣΤΙΣ {time}. ΗΜΕΡΟΛΟΓΙΟ: {calendar_link}'),
        'confirmation_request', jsonb_build_object('enabled',true,'text','ΥΠΕΝΘΥΜΙΖΟΥΜΕ ΤΟ ΡΑΝΤΕΒΟΥ ΣΑΣ ΣΤΟ {clinic} ΓΙΑ {date} ΣΤΙΣ {time}. ΕΠΙΒΕΒΑΙΩΣΤΕ: {confirm_link}'),
        'instructions', jsonb_build_object('enabled',true,'text','ΟΙ ΟΔΗΓΙΕΣ ΠΡΙΝ ΚΑΙ ΜΕΤΑ ΤΗ ΘΕΡΑΠΕΙΑ ΣΑΣ: {instructions_link}'),
        'review_request', jsonb_build_object('enabled',true,'text','ΕΥΧΑΡΙΣΤΟΥΜΕ ΓΙΑ ΤΗΝ ΕΠΙΣΚΕΨΗ ΣΑΣ ΣΤΟ {clinic}! ΑΞΙΟΛΟΓΗΣΤΕ ΜΑΣ: {review_link}'),
        'birthday_gift', jsonb_build_object('enabled',true,'text','ΧΡΟΝΙΑ ΠΟΛΛΑ! ΔΩΡΟ {value}€ ΘΕΡΑΠΕΙΑ ΠΡΟΣΩΠΟΥ ΕΩΣ {expires}. ΤΗΛ {phone}')),
      'review_request_enabled', true,
      'review_request_delay_minutes', 30,
      'review_link', 'https://g.page/r/demo-clinic/review')
  where id = demo;

  -- ── 2. Κατάλογος υπηρεσιών δερματολογικού ιατρείου, οδηγίες, πρότυπα συναινέσεων ──
  insert into services (clinic_id, name, category, duration_minutes, price, active) values
    (demo, 'Δερματολογική Εξέταση', cats[1], 30, 60, true),
    (demo, 'Επανεξέταση', cats[1], 20, 40, true),
    (demo, 'Χαρτογράφηση Σπίλων — Δερματοσκόπηση', cats[1], 45, 120, true),
    (demo, 'Κρυοθεραπεία Μυρμηγκιών / Υπερκερατώσεων', cats[1], 15, 50, true),
    (demo, 'Βιοψία Δέρματος', cats[1], 30, 150, true),
    (demo, 'Πρόγραμμα Θεραπείας Ακμής — Έλεγχος', cats[1], 30, 70, true),
    (demo, 'Τριχόπτωση — Εκτίμηση & Τριχοσκόπηση', cats[1], 45, 90, true),
    (demo, 'Έλεγχος Ονύχων / Ονυχομυκητίαση', cats[1], 20, 50, true),
    (demo, 'Αφαίρεση Σπίλου / Θηλώματος', cats[1], 30, 180, true),
    (demo, 'Patch Test — Αλλεργία Επαφής', cats[1], 30, 130, true),
    (demo, 'Botox Μετώπου / Γλαβέλλας', cats[2], 30, 250, true),
    (demo, 'Botox Full Face', cats[2], 45, 380, true),
    (demo, 'Υαλουρονικό Χείλη (1ml)', cats[2], 45, 300, true),
    (demo, 'Υαλουρονικό Ρινοπαρειακές', cats[2], 45, 320, true),
    (demo, 'Skin Boosters (Profhilo)', cats[2], 30, 280, true),
    (demo, 'PRP Προσώπου', cats[2], 60, 250, true),
    (demo, 'PRP Τριχωτού', cats[2], 60, 220, true),
    (demo, 'Μεσοθεραπεία Τριχωτού', cats[2], 45, 120, true),
    (demo, 'Botox Υπεριδρωσίας Μασχαλών', cats[2], 30, 400, true),
    (demo, 'Laser Αποτρίχωση Άνω Χείλος', cats[3], 15, 30, true),
    (demo, 'Laser Αποτρίχωση Μασχάλες', cats[3], 20, 50, true),
    (demo, 'Laser Αποτρίχωση Πόδια Ολόκληρα', cats[3], 75, 160, true),
    (demo, 'Laser Αποτρίχωση Μπικίνι', cats[3], 30, 70, true),
    (demo, 'Laser Αποτρίχωση Πρόσωπο', cats[3], 20, 60, true),
    (demo, 'Laser Αποτρίχωση Πλάτη Ανδρική', cats[3], 40, 120, true),
    (demo, 'Fractional CO2 Laser Ουλών Ακμής', cats[3], 45, 350, true),
    (demo, 'IPL Φωτοανάπλαση — Πανάδες', cats[3], 30, 180, true),
    (demo, 'Laser Αγγειακών Βλαβών / Ευρυαγγειών', cats[3], 30, 200, true),
    (demo, 'Laser Αφαίρεση Τατουάζ', cats[3], 30, 150, true),
    (demo, 'Laser Ονυχομυκητίασης', cats[3], 30, 120, true),
    (demo, 'Χημικό Peeling Σαλικυλικού', cats[4], 30, 90, true),
    (demo, 'Peeling Γλυκολικού', cats[4], 30, 80, true),
    (demo, 'TCA Peeling', cats[4], 45, 150, true),
    (demo, 'Microneedling Dermapen', cats[4], 60, 180, true),
    (demo, 'Υδροδερμοαπόξεση', cats[4], 60, 110, true),
    (demo, 'Βαθύς Καθαρισμός Προσώπου — Ιατρικός', cats[4], 60, 75, true),
    (demo, 'Θεραπεία Ροδόχρου Νόσου LED', cats[4], 30, 60, true),
    (demo, 'Οξυγονοθεραπεία', cats[4], 45, 70, true),
    (demo, 'Ενυδάτωση Υαλουρονικού', cats[4], 45, 65, true);

  insert into instruction_sets (clinic_id, name, description, pre_instructions, post_instructions, active) values
    (demo, 'Laser Αποτρίχωσης', 'Οδηγίες πριν/μετά τη συνεδρία laser',
      E'• Ξύρισμα της περιοχής 24 ώρες πριν (όχι κερί/τσιμπιδάκι για 4 εβδομάδες)\n• Αποφυγή ήλιου & σολάριουμ για 2 εβδομάδες\n• Χωρίς αυτομαυριστικά, κρέμες με ρετινόλη ή οξέα για 5 ημέρες\n• Ενημερώστε μας για φάρμακα φωτοευαισθησίας ή εγκυμοσύνη',
      E'• Κρύες κομπρέσες / αλόη σε ερυθρότητα\n• SPF 50 καθημερινά στην περιοχή για 2 εβδομάδες\n• Όχι σάουνα, έντονη άσκηση, ζεστό μπάνιο για 24 ώρες\n• Οι τρίχες πέφτουν σταδιακά σε 7–14 ημέρες — μην τις τραβάτε', true),
    (demo, 'Χημικό Peeling', 'Οδηγίες πριν/μετά το peeling',
      E'• Διακοπή ρετινοειδών και οξέων 5 ημέρες πριν\n• Χωρίς αποτρίχωση/ξύρισμα προσώπου 48 ώρες πριν\n• Αποφυγή ήλιου την προηγούμενη εβδομάδα\n• Ενημερώστε μας για επεισόδιο έρπητα ή ισοτρετινοΐνη τους τελευταίους 6 μήνες',
      E'• Ήπιος καθαρισμός & ενυδατική — χωρίς τρίψιμο\n• Μην αφαιρείτε την απολέπιση με τα χέρια\n• SPF 50 κάθε 2–3 ώρες σε έκθεση για 2 εβδομάδες\n• Μακιγιάζ από την επόμενη ημέρα, όχι σάουνα/πισίνα για 3 ημέρες', true),
    (demo, 'Ενέσιμες Θεραπείες (Botox / Fillers)', 'Οδηγίες πριν/μετά τις ενέσιμες θεραπείες',
      E'• Αποφυγή ασπιρίνης, ιβουπροφαίνης, ωμέγα-3 & βιταμίνης Ε για 5 ημέρες (μειώνουν τις εκχυμώσεις)\n• Χωρίς αλκοόλ 24 ώρες πριν\n• Έρθετε χωρίς μακιγιάζ\n• Ενημερώστε μας για εγκυμοσύνη/θηλασμό, νευρομυϊκά νοσήματα ή αντιπηκτικά',
      E'• Μην τρίβετε/πιέζετε την περιοχή για 6 ώρες — όρθια στάση για 4 ώρες\n• Χωρίς έντονη άσκηση, σάουνα, ζέστη για 24 ώρες\n• Παγοκύστη σε τυχόν πρήξιμο (fillers)\n• Το Botox αποδίδει σε 5–14 ημέρες — επανέλεγχος στις 2 εβδομάδες', true),
    (demo, 'Microneedling / PRP', 'Οδηγίες πριν/μετά microneedling & PRP',
      E'• Καλή ενυδάτωση (νερό) την προηγούμενη ημέρα — ιδίως για PRP\n• Διακοπή ρετινοειδών 3 ημέρες πριν\n• Χωρίς αντιφλεγμονώδη 3 ημέρες πριν (PRP)\n• Χωρίς μακιγιάζ την ημέρα της θεραπείας',
      E'• Ερυθρότητα σαν ηλιακό έγκαυμα για 24–48 ώρες είναι αναμενόμενη\n• Μόνο ήπιος καθαρισμός & ενυδατική για 3 ημέρες — χωρίς οξέα/ρετινόλη για 1 εβδομάδα\n• SPF 50 αυστηρά για 2 εβδομάδες\n• Χωρίς πισίνα/σάουνα/γυμναστήριο για 48 ώρες', true),
    (demo, 'Fractional CO2 / IPL / Laser Βλαβών', 'Οδηγίες πριν/μετά ενεργειακές θεραπείες προσώπου',
      E'• Καμία έκθεση στον ήλιο για 3 εβδομάδες πριν — μαυρισμένο δέρμα ΔΕΝ γίνεται θεραπεία\n• Διακοπή ρετινοειδών/οξέων 1 εβδομάδα πριν\n• Αντιιική προφύλαξη αν έχετε ιστορικό έρπητα (θα σας δοθεί συνταγή)\n• Ξεκινήστε την προετοιμασία δέρματος που σας δόθηκε',
      E'• Επουλωτική αλοιφή όπως συνταγογραφήθηκε 3–5 φορές την ημέρα\n• Χωρίς μακιγιάζ μέχρι να πέσουν οι κρούστες (5–7 ημέρες)\n• Καθόλου ήλιος για 4 εβδομάδες, SPF 50 για 3 μήνες\n• Επικοινωνήστε άμεσα για έντονο πόνο, πύον ή πυρετό', true),
    (demo, 'Βιοψία / Μικροεπέμβαση', 'Οδηγίες πριν/μετά βιοψία, αφαίρεση σπίλου, κρυοθεραπεία',
      E'• Ενημερώστε μας για αντιπηκτικά, αλλεργία σε τοπικά αναισθητικά ή βηματοδότη\n• Φάτε κανονικά — δεν απαιτείται νηστεία\n• Φορέστε άνετα ρούχα που αφήνουν ελεύθερη την περιοχή',
      E'• Κρατήστε το επίθεμα στεγνό για 24 ώρες, μετά καθημερινή αλλαγή\n• Αποφύγετε τέντωμα/άσκηση της περιοχής για 5–7 ημέρες\n• Αφαίρεση ραμμάτων σε 7–14 ημέρες (θα οριστεί ραντεβού)\n• Το ιστολογικό αποτέλεσμα βγαίνει σε 10–15 ημέρες — θα σας ενημερώσουμε', true);

  insert into service_instruction_map (clinic_id, service_id, instruction_set_id)
    select demo, s.id, i.id from services s join instruction_sets i on i.clinic_id = demo
    where s.clinic_id = demo and (
      (i.name = 'Laser Αποτρίχωσης' and s.name like laser_prefix || '%') or
      (i.name = 'Χημικό Peeling' and s.name ilike '%Peeling%') or
      (i.name = 'Ενέσιμες Θεραπείες (Botox / Fillers)' and (s.name ilike 'Botox%' or s.name ilike 'Υαλουρονικό%' or s.name ilike 'Skin Boosters%')) or
      (i.name = 'Microneedling / PRP' and (s.name ilike '%PRP%' or s.name ilike '%Microneedling%' or s.name ilike 'Μεσοθεραπεία%')) or
      (i.name = 'Fractional CO2 / IPL / Laser Βλαβών' and (s.name ilike 'Fractional%' or s.name ilike 'IPL%' or s.name ilike 'Laser Αγγειακ%' or s.name ilike 'Laser Αφαίρεση%')) or
      (i.name = 'Βιοψία / Μικροεπέμβαση' and (s.name ilike 'Βιοψία%' or s.name ilike 'Αφαίρεση%' or s.name ilike 'Κρυοθεραπεία%')));

  insert into service_consent_templates (clinic_id, service_name, consent_text, active) values
    (demo, 'Καθαρισμός Προσώπου', 'ΣΥΝΑΙΝΕΣΗ ΓΙΑ ΚΑΘΑΡΙΣΜΟ ΠΡΟΣΩΠΟΥ / ΥΔΡΟΔΕΡΜΟΑΠΟΞΕΣΗ' || E'\n\n' || 'Ενημερώθηκα για τη φύση της θεραπείας, τα αναμενόμενα αποτελέσματα και τις πιθανές παροδικές αντιδράσεις (ερυθρότητα, ευαισθησία, μικρές εκχυμώσεις). Δήλωσα με ακρίβεια το ιατρικό μου ιστορικό, τα φάρμακα και τις αλλεργίες μου. Κατανοώ ότι τα αποτελέσματα διαφέρουν ανά άτομο και συναινώ στη διενέργεια της θεραπείας.', true),
    (demo, 'Peeling', 'ΣΥΝΑΙΝΕΣΗ ΓΙΑ ΧΗΜΙΚΟ PEELING' || E'\n\n' || 'Ενημερώθηκα ότι το χημικό peeling προκαλεί ελεγχόμενη απολέπιση και ότι είναι αναμενόμενα ερυθρότητα, αίσθημα καύσου, ξηρότητα και απολέπιση για 3–7 ημέρες. Κατανοώ τους σπάνιους κινδύνους (μεταφλεγμονώδης υπέρχρωση, λοίμωξη, ενεργοποίηση έρπητα) και τη σημασία της αυστηρής φωτοπροστασίας. Δεν λαμβάνω ισοτρετινοΐνη τους τελευταίους 6 μήνες. Συναινώ στη θεραπεία.', true),
    (demo, 'Θεραπεία Προσώπου', 'ΣΥΝΑΙΝΕΣΗ ΓΙΑ ΘΕΡΑΠΕΙΑ ΠΡΟΣΩΠΟΥ (LED / ΟΞΥΓΟΝΟΘΕΡΑΠΕΙΑ / ΕΝΥΔΑΤΩΣΗ)' || E'\n\n' || 'Ενημερώθηκα για τη διαδικασία και τα αναμενόμενα αποτελέσματα. Δήλωσα τυχόν φωτοευαισθησία, φάρμακα και αλλεργίες. Κατανοώ ότι μπορεί να εμφανιστεί παροδική ερυθρότητα και συναινώ στη θεραπεία.', true),
    (demo, 'Μεσοθεραπεία', 'ΣΥΝΑΙΝΕΣΗ ΓΙΑ MICRONEEDLING / PRP / ΜΕΣΟΘΕΡΑΠΕΙΑ' || E'\n\n' || 'Ενημερώθηκα ότι η θεραπεία περιλαμβάνει μικροτραυματισμό του δέρματος ή/και έγχυση αυτόλογου πλάσματος. Αναμενόμενα: ερυθρότητα, οίδημα, μικρές εκχυμώσεις 1–3 ημέρες. Κατανοώ τους σπάνιους κινδύνους λοίμωξης ή υπέρχρωσης και τη σημασία της φωτοπροστασίας. Συναινώ στη θεραπεία και στη λήψη φωτογραφιών για τον ιατρικό μου φάκελο.', true),
    (demo, 'Ενέσιμες Θεραπείες', 'ΣΥΝΑΙΝΕΣΗ ΓΙΑ ΕΝΕΣΙΜΕΣ ΘΕΡΑΠΕΙΕΣ (ΒΟΤΟΥΛΙΝΙΚΗ ΤΟΞΙΝΗ / ΥΑΛΟΥΡΟΝΙΚΟ ΟΞΥ)' || E'\n\n' || 'Ενημερώθηκα από τον ιατρό για τον σκοπό, τη διαδικασία, τα αναμενόμενα αποτελέσματα και τη διάρκειά τους, καθώς και για τις πιθανές ανεπιθύμητες ενέργειες (εκχύμωση, οίδημα, ασυμμετρία, σπανίως πτώση βλεφάρου ή αγγειακή απόφραξη). Δήλωσα ότι δεν είμαι έγκυος/θηλάζουσα και δεν πάσχω από νευρομυϊκό νόσημα. Συναινώ στη θεραπεία.', true),
    (demo, 'Laser', 'ΣΥΝΑΙΝΕΣΗ ΓΙΑ ΘΕΡΑΠΕΙΑ LASER' || E'\n\n' || 'Ενημερώθηκα ότι η θεραπεία με laser μπορεί να προκαλέσει παροδική ερυθρότητα, οίδημα, σπανίως φυσαλίδες, υπέρ/υπόχρωση ή ουλή. Δήλωσα την πρόσφατη έκθεση στον ήλιο, τα φάρμακα φωτοευαισθησίας και το ιστορικό μου. Κατανοώ ότι απαιτούνται πολλαπλές συνεδρίες και συναινώ στη θεραπεία.', true);

  -- ── 3. Προσωπικό: λογαριασμοί, προφίλ, ωράριο, άδειες, υπηρεσίες ─────────
  create temp table tmp_staff (id uuid, name text, role text, email text, phone text, active boolean, leave numeric,
    pool text[], days int[], st time, en time, sat_st time, sat_en time, until date) on commit drop;
  -- Δερματολόγος-διευθύντρια, δερματολόγος (laser & μικροεπεμβάσεις), αισθητικός,
  -- νοσηλεύτρια laser αποτρίχωσης, και μία πρώην αισθητικός (ανενεργή).
  insert into tmp_staff values
    (s_admin,'Δρ. Ελένη Παπαδάκη','clinic_admin','eleni.papadaki@demo-clinic.gr','6971000001',true,25, array[cats[1],cats[2]], array[1,2,3,4,5], '10:00','18:00', null, null, null),
    (s_nikos,'Δρ. Νίκος Αντωνόπουλος','therapist','nikos.antonopoulos@demo-clinic.gr','6971000004',true,25, array[cats[1],cats[2],cats[3]], array[1,2,3,4,5], '12:00','21:00', '09:00','14:00', null),
    (s_maria,'Μαρία Κωνσταντίνου','therapist','maria.konstantinou@demo-clinic.gr','6971000002',true,20, array[cats[4]], array[2,3,4,5,6], '12:00','21:00', '09:00','15:00', null),
    (s_sofia,'Σοφία Αντωνίου','therapist','sofia.antoniou@demo-clinic.gr','6971000003',true,20, array[cats[3]], array[1,2,3,4,5,6], '09:00','17:00', '09:00','15:00', null),
    (s_niki,'Νίκη Αλεξίου','therapist','niki.alexiou@demo-clinic.gr','6971000005',false,20, array[cats[4]], array[1,2,3,4,5], '09:00','17:00', null, null, '2026-05-29');

  for st in select * from tmp_staff loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
      phone_change, phone_change_token, reauthentication_token, is_sso_user, is_anonymous)
    values (st.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', st.email,
      extensions.crypt('Demo2026!', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('full_name', st.name, 'role', st.role),
      now() - interval '400 days', now(), '', '', '', '', '', '', '', '', false, false);
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (st.id::text, st.id, jsonb_build_object('sub', st.id::text, 'email', st.email, 'email_verified', true), 'email', now(), now(), now());
    insert into profiles (id, clinic_id, full_name, role, phone, active, annual_leave_days)
    values (st.id, demo, st.name, st.role, st.phone, st.active, st.leave)
    on conflict (id) do update set clinic_id = excluded.clinic_id, full_name = excluded.full_name, role = excluded.role,
      phone = excluded.phone, active = excluded.active, annual_leave_days = excluded.annual_leave_days;

    for wd in 0..6 loop
      insert into staff_schedules (clinic_id, staff_id, day_of_week, is_working, start_time, end_time)
      values (demo, st.id, wd,
        (wd = any(st.days)) or (wd = 6 and st.sat_st is not null),
        case when wd = 6 then coalesce(st.sat_st, '09:00'::time) else st.st end,
        case when wd = 6 then coalesce(st.sat_en, '15:00'::time) else st.en end);
    end loop;
    -- Η Σοφία (νοσηλεύτρια) κάνει ΜΟΝΟ laser αποτρίχωσης — τα ιατρικά laser
    -- (CO2, IPL, αγγειακά, τατουάζ) τα κάνει μόνο ο Δρ. Αντωνόπουλος.
    insert into staff_services (clinic_id, staff_id, service_id, online_booking_enabled)
      select demo, st.id, s.id, (s.category in (cats[1], cats[4]) or s.name like laser_prefix || '%')
      from services s where s.clinic_id = demo and s.category = any(st.pool)
        and not (st.id = s_sofia and s.name not like laser_prefix || '%')
        and not (st.id = s_nikos and s.name like laser_prefix || '%');
  end loop;

  insert into staff_time_off (clinic_id, staff_id, start_date, end_date, type, days_count, notes) values
    (demo, s_admin, '2026-08-03', '2026-08-14', 'vacation', 10, 'Καλοκαιρινή άδεια'),
    (demo, s_admin, '2026-02-11', '2026-02-11', 'sick', 1, null),
    (demo, s_admin, '2026-11-09', '2026-11-13', 'vacation', 5, 'Συνέδριο δερματολογίας — Βαρκελώνη'),
    (demo, s_maria, '2026-07-20', '2026-07-31', 'vacation', 10, null),
    (demo, s_maria, '2026-03-03', '2026-03-04', 'sick', 2, 'Ίωση'),
    (demo, s_sofia, '2026-08-17', '2026-08-28', 'vacation', 10, null),
    (demo, s_sofia, '2026-05-22', '2026-05-22', 'other', 1, 'Σεμινάριο Candela'),
    (demo, s_nikos, '2026-08-10', '2026-08-21', 'vacation', 10, null),
    (demo, s_nikos, '2026-09-08', '2026-09-09', 'sick', 2, null),
    (demo, s_nikos, '2026-12-28', '2026-12-31', 'vacation', 4, 'Πρωτοχρονιά'),
    (demo, s_niki, '2026-04-13', '2026-04-17', 'vacation', 5, null);
  insert into staff_schedule_overrides (clinic_id, staff_id, date, is_working, start_time, end_time, notes) values
    (demo, s_sofia, '2026-09-19', false, null, null, 'Προσωπικός λόγος'),
    (demo, s_admin, '2026-09-26', true, '09:00', '14:00', 'Έκτακτο Σάββατο — λίστα αναμονής'),
    (demo, s_maria, '2026-10-05', true, '12:00', '18:00', 'Αλλαγή βάρδιας');

  -- ── 4. Ασθενείς ───────────────────────────────────────────────────────────
  create temp table tmp_p (i int primary key, id uuid, name text, gender text, dob date, city text, source text,
    email text, phone text, amka text, is_lead boolean, inactive boolean, pcat text, active_from date, active_to date) on commit drop;
  for ii in 1..60 loop
    insert into tmp_p values (ii,
      ('e0000000-0000-4000-8000-' || lpad(to_hex(ii), 12, '0'))::uuid,
      names[ii],
      case when ii between 51 and 58 then 'male' else 'female' end,
      case ii when 1 then '1968-03-12' when 2 then '1996-07-04' when 3 then '1985-11-23' when 4 then '1988-02-15'
             when 5 then '1990-06-05' when 8 then '1979-01-30' when 11 then '1984-09-17' when 13 then '1972-08-17'
             when 21 then '1993-10-09' when 27 then '1991-09-19' when 34 then '1988-04-14' when 51 then '1982-09-22'
             else (date '1962-01-01' + (random() * 15500)::int) end,
      cities[1 + (random() * (array_length(cities,1) - 1))::int],
      sources[1 + (random() * (array_length(sources,1) - 1))::int],
      case when ii = any(no_email_ids) then null else emails[ii] || '@example.com' end,
      '697' || lpad(((1000000 + (ii * 7919) % 8999999))::text, 7, '0'),
      null,
      ii = any(lead_ids), ii = any(inactive_ids),
      case when ii between 51 and 54 then cats[1] when ii between 55 and 58 then cats[3]
           else cats[1 + (ii % 4)] end,
      case when ii = any(lead_ids) then null
           when ii <= 20 then date '2025-10-01' + (random() * 40)::int
           when ii = any(inactive_ids) then date '2025-10-01' + (random() * 45)::int
           else date '2025-11-15' + (random() * 230)::int end,
      case when ii = any(inactive_ids) then date '2026-01-05' + (random() * 45)::int else null end);
  end loop;
  update tmp_p set amka = to_char(dob, 'DDMMYY') || lpad((floor(random() * 99999))::int::text, 5, '0');

  insert into patients (id, clinic_id, full_name, phone, email, gender, dob, city, source, status, notes, is_student,
                        marketing_opt_in, amka, created_at, updated_at)
    select id, demo, name, phone, email, gender, dob, city, source,
      case when is_lead then 'lead' when inactive then 'inactive' else 'active' end,
      case when i % 9 = 0 then 'Προτιμά απογευματινά ραντεβού' when i % 11 = 0 then 'Ευαίσθητη σε έντονα αρώματα' else null end,
      (extract(year from dob) >= 2002),
      (random() < 0.8), amka,
      case when is_lead then (today - (random() * 40)::int)::timestamp at time zone tz + interval '11 hours'
           else (active_from - (random() * 10)::int)::timestamp at time zone tz + interval '10 hours' end,
      now()
    from tmp_p;

  -- ── 5. Ραντεβού: ημέρα-ημέρα, ανά θεραπεύτρια, μέσα στο ωράριό της ───────
  for d in select generate_series(date '2025-10-01', date '2026-12-19', '1 day')::date loop
    wd := extract(isodow from d)::int % 7;  -- 0 = Κυριακή, όπως το staff_schedules.day_of_week
    continue when wd = 0 or d = any(closed);
    factor := case to_char(d, 'YYYY-MM')
      when '2025-10' then 0.55 when '2025-11' then 0.60 when '2025-12' then 0.72 when '2026-01' then 0.50
      when '2026-02' then 0.58 when '2026-03' then 0.66 when '2026-04' then 0.72 when '2026-05' then 0.82
      when '2026-06' then 0.88 when '2026-07' then 0.76 when '2026-08' then 0.40 when '2026-09' then 0.90
      else 0.85 end;
    if d > today then
      ahead := d - today;
      factor := factor * case when ahead <= 14 then 0.85 when ahead <= 30 then 0.55 when ahead <= 60 then 0.30 else 0.12 end;
    elsif d = today then
      factor := 1.4;
    end if;

    for st in select ts.*, ss.start_time as ss_start, ss.end_time as ss_end, ss.is_working
              from tmp_staff ts join staff_schedules ss on ss.staff_id = ts.id and ss.day_of_week = wd loop
      continue when st.until is not null and d > st.until;
      continue when not st.active and d > coalesce(st.until, d);
      sched_start := st.ss_start; sched_end := st.ss_end;
      if not st.is_working then continue; end if;
      continue when exists (select 1 from staff_time_off o where o.staff_id = st.id and d between o.start_date and o.end_date);
      select o.is_working, o.start_time, o.end_time into pr from staff_schedule_overrides o where o.staff_id = st.id and o.date = d;
      if found then
        if not pr.is_working then continue; end if;
        sched_start := pr.start_time; sched_end := pr.end_time;
      end if;

      select array_agg(s.id) into svc_ids from services s join staff_services x on x.service_id = s.id
        where x.staff_id = st.id and s.clinic_id = demo and s.active;
      t := sched_start;
      while t + interval '30 minutes' <= sched_end loop
        if random() < 0.13 * factor then
          sid := svc_ids[1 + (random() * (array_length(svc_ids,1) - 1))::int];
          select name, category, duration_minutes, price into sv from services where id = sid;
          dur := greatest(15, ceil(sv.duration_minutes / 15.0)::int * 15);
          if t + (dur || ' minutes')::interval > sched_end then
            t := t + interval '15 minutes'; continue;
          end if;
          pid := null;
          if random() < 0.8 then
            select id into pid from tmp_p where not is_lead and active_from <= d and (active_to is null or active_to >= d) and pcat = sv.category order by random() limit 1;
          end if;
          if pid is null then
            select id into pid from tmp_p where not is_lead and active_from <= d and (active_to is null or active_to >= d) order by random() limit 1;
          end if;
          if pid is null then t := t + interval '15 minutes'; continue; end if;

          start_ts := (d + t)::timestamp at time zone tz;
          r := random();
          if d < today then
            a_status := case when r < 0.86 then 'completed' when r < 0.94 then 'cancelled' when r < 0.98 then 'no_show' else 'rescheduled' end;
          elsif d - today <= 2 then
            a_status := case when r < 0.7 then 'confirmed' else 'booked' end;
          else
            a_status := case when r < 0.85 then 'booked' else 'confirmed' end;
          end if;
          a_price := sv.price;
          a_paid := case when a_status = 'completed' then a_price else 0 end;
          created_ts := start_ts - ((1 + (random() * 20)::int) || ' days')::interval - interval '3 hours';
          a_note := case when random() < 0.1 then appt_notes[1 + (random() * (array_length(appt_notes,1) - 1))::int] else null end;
          aid := gen_random_uuid();
          insert into appointments (id, clinic_id, patient_id, therapist_id, service_name, body_parts, start_time, end_time, duration_minutes,
            status, notes, price, paid_amount, from_booking, sms_sent, sms_confirmed, created_at, updated_at, created_by)
          values (aid, demo, pid, st.id, sv.name,
            case when sv.name like laser_prefix || '%' then array[substr(sv.name, length(laser_prefix) + 1)] else null end,
            start_ts, start_ts + (dur || ' minutes')::interval, dur, a_status, a_note, a_price, a_paid,
            (random() < 0.3), (d >= '2026-06-01' and d < today), (a_status = 'confirmed'),
            created_ts, created_ts, case when random() < 0.5 then s_admin else st.id end);
          n_appts := n_appts + 1;
          gap := (array[0, 15, 15, 30])[1 + (random() * 3)::int];
          t := t + ((dur + gap) || ' minutes')::interval;
        else
          t := t + interval '15 minutes';
        end if;
      end loop;
    end loop;
  end loop;

  -- Ημ/νία εγγραφής ≤ πρώτο ραντεβού
  update patients p set created_at = least(p.created_at, x.first_created)
    from (select patient_id, min(created_at) - interval '2 days' as first_created from appointments where clinic_id = demo group by patient_id) x
    where p.id = x.patient_id;

  -- ── 6. GDPR, ιατρικό ιστορικό, συναινέσεις υπηρεσιών, laser ──────────────
  insert into gdpr_consents (patient_id, clinic_id, consent_text, signed_at, ip_address, signature_data)
    select p.id, demo, gdpr_txt, x.first_start - interval '20 minutes', '10.20.30.' || (p.i % 200 + 10), sig
    from tmp_p p join (select patient_id, min(start_time) first_start from appointments where clinic_id = demo group by patient_id) x on x.patient_id = p.id
    where not p.is_lead and p.i % 13 <> 0;
  update patients p set gdpr_signed = true, gdpr_signed_at = g.signed_at, gdpr_text_snapshot = g.consent_text
    from gdpr_consents g where g.patient_id = p.id and p.clinic_id = demo;

  for pr in select p.*, x.first_start from tmp_p p
            join (select patient_id, min(start_time) first_start from appointments where clinic_id = demo group by patient_id) x on x.patient_id = p.id
            where not p.is_lead and p.i % 5 <> 4 loop
    update patients set
      medical_history = case when pr.i % 3 = 0 then 'Καμία γνωστή πάθηση' else conditions[1 + (pr.i % array_length(conditions,1))] end,
      allergies = case when pr.i % 4 = 0 then allergies_l[1 + (pr.i % array_length(allergies_l,1))] else null end,
      medications = case when pr.i % 3 = 1 then meds_l[1 + (pr.i % array_length(meds_l,1))] else null end,
      previous_treatments = prev_l[1 + (pr.i % array_length(prev_l,1))],
      avoid_body_areas = case when pr.i % 17 = 0 then 'Περιοχή τατουάζ αριστερού ώμου' else null end,
      medical_history_completed = true, medical_history_completed_at = pr.first_start - interval '15 minutes'
    where id = pr.id;
    insert into medical_history_consents (clinic_id, patient_id, signed_at, signature_data, collected_by, consent_version, snapshot, created_at)
    select demo, pr.id, pr.first_start - interval '15 minutes', sig, 'Δρ. Ελένη Παπαδάκη', 'v1',
      jsonb_build_object('full_name', pr.name, 'phone', pr.phone, 'email', pr.email, 'dob', pr.dob, 'city', pr.city, 'source', pr.source,
        'conditions', case when p.medical_history = 'Καμία γνωστή πάθηση' then '[]'::jsonb else jsonb_build_array(p.medical_history) end,
        'condition_other', null, 'allergies', p.allergies, 'medications', p.medications, 'previous_treatments', p.previous_treatments,
        'avoid_body_areas', p.avoid_body_areas, 'marketing_opt_in', p.marketing_opt_in),
      pr.first_start - interval '15 minutes'
    from patients p where p.id = pr.id;
  end loop;

  -- Συναινέσεις υπηρεσιών: μία ανά ομάδα, στην πρώτη σχετική θεραπεία
  for pr in
    select a.patient_id, grp_name as grp, svc_label, tmpl_name, min(a.start_time) first_start, (array_agg(a.id order by a.start_time))[1] first_appt,
           (array_agg(a.therapist_id order by a.start_time))[1] ther
    from appointments a
    cross join lateral (
      -- Οι 3 ομάδες συναινέσεων είναι σταθερές στο CRM (καρτέλα ασθενή): αντιστοίχιση
      -- των δερματολογικών υπηρεσιών σε αυτές.
      select case when a.service_name ilike '%Καθαρισμ%' or a.service_name ilike '%Υδροδερμ%' then 'cleansing_poreover'
                  when a.service_name ilike '%Peeling%' or a.service_name ilike '%Microneedling%' or a.service_name ilike '%PRP%' or a.service_name ilike 'Μεσοθεραπεία%' then 'peelings_microneedling'
                  when a.service_name ilike '%Ενυδάτωση%' or a.service_name ilike '%Οξυγονο%' or a.service_name ilike '%LED%' then 'oxygen_facetreatments' end as grp_name,
             case when a.service_name ilike '%Καθαρισμ%' or a.service_name ilike '%Υδροδερμ%' then 'Καθαρισμός Προσώπου / Υδροδερμοαπόξεση'
                  when a.service_name ilike '%Peeling%' or a.service_name ilike '%Microneedling%' or a.service_name ilike '%PRP%' or a.service_name ilike 'Μεσοθεραπεία%' then 'Peeling & Microneedling / PRP'
                  else 'Θεραπείες Προσώπου (LED / Οξυγόνο / Ενυδάτωση)' end as svc_label,
             case when a.service_name ilike '%Καθαρισμ%' or a.service_name ilike '%Υδροδερμ%' then 'Καθαρισμός Προσώπου'
                  when a.service_name ilike '%Peeling%' then 'Peeling'
                  when a.service_name ilike '%Microneedling%' or a.service_name ilike '%PRP%' or a.service_name ilike 'Μεσοθεραπεία%' then 'Μεσοθεραπεία'
                  else 'Θεραπεία Προσώπου' end as tmpl_name) g
    where a.clinic_id = demo and a.status = 'completed' and g.grp_name is not null
    group by a.patient_id, grp_name, svc_label, tmpl_name
  loop
    select consent_text into tmpl from service_consent_templates where clinic_id = demo and service_name = pr.tmpl_name limit 1;
    insert into service_consents (patient_id, clinic_id, service_name, consent_text, signed_at, signature_data, appointment_id, collected_by, consent_version, photo_consent, consent_group)
    values (pr.patient_id, demo, pr.svc_label, coalesce(tmpl, 'Συναίνεση για ' || pr.svc_label || ' (demo)'), pr.first_start - interval '15 minutes', sig, pr.first_appt,
      coalesce((select full_name from profiles where id = pr.ther), 'Δρ. Ελένη Παπαδάκη'), 'v1', (random() < 0.6), pr.grp);
  end loop;

  -- Συναίνεση Laser + Laser forms + πακέτα
  insert into laser_consents (clinic_id, patient_id, signed_at, signature_data, photo_consent, body_areas, collected_by, consent_version)
    select demo, patient_id, min(start_time) - interval '15 minutes', sig, (random() < 0.5),
           string_agg(distinct body_parts[1], ', '), 'Σοφία Αντωνίου', 'v1'
    from appointments where clinic_id = demo and body_parts is not null and status = 'completed' group by patient_id;

  n := 0;
  for pr in
    select patient_id, body_parts[1] as bp, service_name, count(*) cnt, min(start_time) first_start, array_agg(id order by start_time) ids,
           array_agg(start_time order by start_time) starts, max(price) svc_price
    from appointments where clinic_id = demo and body_parts is not null and status = 'completed'
    group by patient_id, body_parts[1], service_name having count(*) >= 2 order by count(*) desc, patient_id limit 12
  loop
    n := n + 1;
    sessions := '[]'::jsonb;
    for k in 1..6 loop
      if k <= least(pr.cnt, 6) then
        sessions := sessions || jsonb_build_object('date', to_char(pr.starts[k] at time zone tz, 'YYYY-MM-DD'), 'spot_size', '18', 'energy', (13 + k)::text, 'dcd', '30', 'notes', case when k = 1 then 'Test patch OK' else '' end);
      else
        sessions := sessions || jsonb_build_object('date', '', 'spot_size', '', 'energy', '', 'dcd', '', 'notes', '');
      end if;
    end loop;
    regions := jsonb_build_array(jsonb_build_object('body_part', pr.bp, 'notes', '', 'sessions', sessions));
    for k in 2..4 loop
      regions := regions || jsonb_build_object('body_part', '', 'notes', '', 'sessions',
        (select jsonb_agg(jsonb_build_object('date','','spot_size','','energy','','dcd','','notes','')) from generate_series(1,6)));
    end loop;
    ms := jsonb_build_object('regions', regions, 'operator', 'Σοφία Αντωνίου', 'start_date', to_char(pr.first_start at time zone tz, 'YYYY-MM-DD'),
                             'hair_colors', case when n % 3 = 0 then jsonb_build_array('Καστανό') else jsonb_build_array('Μαύρο') end);
    form_id := gen_random_uuid();
    insert into laser_forms (id, clinic_id, patient_id, appointment_id, therapist_id, session_number, gender, body_parts, machine_settings, skin_type,
                             treatment_notes, consent_signed, consent_signed_at, created_at)
    select form_id, demo, pr.patient_id, pr.ids[1], s_sofia, least(pr.cnt, 6), p.gender, array[pr.bp], ms,
           (array['II','III','III','IV'])[1 + (n % 4)],
           case when n % 4 = 0 then 'Ήπιο ερύθημα μετά τη 2η συνεδρία — υποχώρησε σε 24h' else null end,
           true, pr.first_start - interval '15 minutes', pr.first_start
    from patients p where p.id = pr.patient_id;

    if n <= 8 then
      pkg_id := gen_random_uuid();
      insert into patient_packages (id, clinic_id, patient_id, name, service_name, total_sessions, price, purchased_at, notes, laser_form_id, body_parts,
                                    receipt_mark, receipt_issued_at, receipt_amount, receipt_payment_method, created_at)
      values (pkg_id, demo, pr.patient_id, 'Πακέτο 6 συνεδριών Laser — ' || pr.bp, pr.service_name, 6, round(pr.svc_price * 6 * 0.85),
              (pr.first_start at time zone tz)::date, case when n % 2 = 0 then 'Προπληρωμή με έκπτωση 15%' else null end, form_id, array[pr.bp],
              case when n <= 5 then '400001' || lpad((9000000 + n * 1234567)::text, 9, '0') else null end,
              case when n <= 5 then pr.first_start + interval '40 minutes' else null end,
              case when n <= 5 then round(pr.svc_price * 6 * 0.85) else null end,
              case when n <= 5 then (array['card','cash'])[1 + (n % 2)] else null end, pr.first_start);
      update appointments set package_id = pkg_id where id = any(pr.ids[1:6]);
    end if;
  end loop;

  -- ── 7. Consultations (Skincare Plans) — 22 ασθενείς με facial ιστορικό ────
  n := 0;
  for pr in
    select a.patient_id, a.id, a.end_time, a.therapist_id, a.start_time
    from appointments a join services s on s.clinic_id = demo and s.name = a.service_name
    where a.clinic_id = demo and a.status = 'completed' and s.category = cats[4] and a.start_time >= '2026-02-01'
      and a.id = (select b.id from appointments b join services s2 on s2.clinic_id = demo and s2.name = b.service_name
                  where b.patient_id = a.patient_id and b.clinic_id = demo and b.status = 'completed' and s2.category = cats[4] and b.start_time >= '2026-02-01'
                  order by b.start_time limit 1)
    order by a.patient_id limit 22
  loop
    n := n + 1;
    skin_i := 1 + (n % array_length(skin_profiles,1));
    -- Βήματα 1–2: υπηρεσίες που η πελάτισσα όντως έκανε ΜΕΤΑ το consultation, ώστε
    -- το tab να δείχνει «✓ Έγινε»· βήμα 3: μία που δεν έχει γίνει ακόμα (⏳).
    select string_agg(service_name, '|') into s1 from (
      select distinct service_name from appointments b join services s on s.clinic_id = demo and s.name = b.service_name
      where b.patient_id = pr.patient_id and b.clinic_id = demo and b.start_time > pr.end_time and s.category in (cats[4], cats[2]) limit 2) x;
    s2 := split_part(coalesce(s1, ''), '|', 2);
    s1 := split_part(coalesce(s1, ''), '|', 1);
    if s1 = '' then s1 := 'Χημικό Peeling Σαλικυλικού'; end if;
    if s2 = '' then s2 := 'Ενυδάτωση Υαλουρονικού'; end if;
    s3 := step3_l[1 + (n % array_length(step3_l,1))];
    consult_text := 'Skincare Plan | Θεραπεύτρια: ' || coalesce((select full_name from profiles where id = pr.therapist_id), 'Δρ. Ελένη Παπαδάκη')
      || E'\nSKIN PROFILE\nΤύπος δέρματος / κύρια ανάγκη:\n' || skin_profiles[skin_i]
      || E'\nEXPECTED RESULTS\nΤι να περιμένετε:\n' || expected_l[skin_i]
      || E'\nIN-CLINIC\n1) Καθαρισμός & Προετοιμασία: ' || s1
      || E'\n2) Θρέψη & Αναζωογόνηση: ' || s2
      || E'\n3) Ενίσχυση & Διατήρηση: ' || s3
      || E'\nHOMECARE\nΚαθημερινός καθαρισμός: ' || clean_l[1 + (n % array_length(clean_l,1))]
      || E'\nΕνεργή περιποίηση: ' || care_l[1 + (n % array_length(care_l,1))]
      || E'\nΠροστασία: ' || prot_l[1 + (n % array_length(prot_l,1))];
    insert into gdpr_consents (patient_id, clinic_id, consent_text, signed_at, ip_address, signature_data)
    values (pr.patient_id, demo, consult_text, pr.end_time + interval '10 minutes', '10.20.30.5', sig);
    -- Οι μισές αγόρασαν το προτεινόμενο προϊόν περιποίησης λίγες μέρες μετά
    if n % 2 = 0 then
      insert into product_sales (clinic_id, patient_id, product_name, quantity, unit_price, amount, payment_method, created_by, created_at)
      values (demo, pr.patient_id, care_l[1 + (n % array_length(care_l,1))], 1, prod_price[5 + (n % 6)], prod_price[5 + (n % 6)],
              (array['cash','card'])[1 + (n % 2)], pr.therapist_id, pr.end_time + ((n % 12) || ' days')::interval + interval '2 hours');
    end if;
  end loop;

  -- ── 8. Πωλήσεις προϊόντων, αναλώσιμα ──────────────────────────────────────
  for k in 1..80 loop
    select id into pid from tmp_p where not is_lead order by random() limit 1;
    n := 1 + (random() * (array_length(prod_l,1) - 1))::int;
    r := case when random() < 0.1 then 2 else 1 end;
    insert into product_sales (clinic_id, patient_id, product_name, quantity, unit_price, amount, payment_method, created_by, created_at)
    values (demo, pid, prod_l[n], r, prod_price[n], prod_price[n] * r, (array['cash','card'])[1 + (random())::int],
            (array[s_admin, s_maria, s_nikos])[1 + (random() * 2)::int],
            (date '2026-01-05' + (random() * (today - date '2026-01-05' - 1))::int)::timestamp at time zone tz + ((10 + (random() * 9)::int) || ' hours')::interval);
  end loop;
  insert into appointment_consumables (clinic_id, appointment_id, patient_id, item_name, quantity, unit, created_by, created_at)
    select demo, a.id, a.patient_id, consumables_l[1 + (random() * (array_length(consumables_l,1) - 1))::int], 1, 'τεμ.', a.therapist_id, a.end_time
    from appointments a where a.clinic_id = demo and a.status = 'completed' and a.start_time >= '2026-06-01' and random() < 0.35;

  -- ── 9. Αυτοματισμοί επικοινωνίας (ό,τι θα είχε στείλει το σύστημα) ──────
  -- booking confirmation: για ραντεβού που κλείστηκαν από το CRM
  insert into communication_log (clinic_id, appointment_id, patient_id, automation_type, channel, recipient, cycle, status, metadata, created_at)
    select demo, a.id, a.patient_id, 'booking_confirmation', case when p.email is null then 'sms' else 'email' end, coalesce(p.email, p.phone),
           to_char(a.start_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS+00:00'), 'sent', '{"gmail_id":"demo"}'::jsonb, a.created_at + interval '1 minute'
    from appointments a join patients p on p.id = a.patient_id
    where a.clinic_id = demo and not a.from_booking and a.created_at >= '2026-06-01' and a.status <> 'rescheduled';
  -- confirmation request 48h πριν
  insert into communication_log (clinic_id, appointment_id, patient_id, automation_type, channel, recipient, cycle, status, metadata, created_at)
    select demo, a.id, a.patient_id, 'confirmation_request', case when p.email is null then 'sms' else 'email' end, coalesce(p.email, p.phone),
           to_char(a.start_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS+00:00'), 'sent', '{"gmail_id":"demo"}'::jsonb, a.start_time - interval '48 hours'
    from appointments a join patients p on p.id = a.patient_id
    where a.clinic_id = demo and a.start_time >= '2026-06-01' and a.start_time - interval '48 hours' <= now() and a.status <> 'rescheduled';
  insert into communication_log (clinic_id, appointment_id, patient_id, automation_type, channel, recipient, cycle, status, created_at)
    select clinic_id, appointment_id, patient_id, 'confirmation_received', 'email', recipient, cycle, 'received', created_at + interval '3 hours'
    from communication_log where clinic_id = demo and automation_type = 'confirmation_request' and channel = 'email' and random() < 0.45;
  insert into communication_log (clinic_id, appointment_id, patient_id, automation_type, channel, recipient, cycle, status, created_at)
    select c.clinic_id, c.appointment_id, c.patient_id, 'cancellation_received', 'email', c.recipient, c.cycle, 'received', c.created_at + interval '5 hours'
    from communication_log c join appointments a on a.id = c.appointment_id
    where c.clinic_id = demo and c.automation_type = 'confirmation_request' and a.status = 'cancelled' and random() < 0.4;
  -- οδηγίες 24h πριν (θεραπείες με σετ οδηγιών)
  insert into communication_log (clinic_id, appointment_id, patient_id, automation_type, channel, recipient, cycle, status, metadata, created_at)
    select distinct on (a.id) demo, a.id, a.patient_id, 'instructions', case when p.email is null then 'sms' else 'email' end, coalesce(p.email, p.phone),
           to_char(a.start_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS+00:00'), 'sent', jsonb_build_object('gmail_id','demo','instruction_set', i2.name), a.start_time - interval '24 hours'
    from appointments a join patients p on p.id = a.patient_id
    join services s on s.clinic_id = demo and s.name = a.service_name
    join service_instruction_map m on m.service_id = s.id join instruction_sets i2 on i2.id = m.instruction_set_id
    where a.clinic_id = demo and a.start_time >= '2026-06-01' and a.start_time - interval '24 hours' <= now() and a.status in ('completed','confirmed','booked','no_show');
  -- αξιολόγηση 30΄ μετά (από Σεπτέμβριο)
  insert into communication_log (clinic_id, appointment_id, patient_id, automation_type, channel, recipient, cycle, status, metadata, created_at)
    select demo, a.id, a.patient_id, 'review_request', case when p.email is null then 'sms' else 'email' end, coalesce(p.email, p.phone),
           to_char(a.start_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS+00:00'), 'sent', '{"gmail_id":"demo"}'::jsonb, a.end_time + interval '30 minutes'
    from appointments a join patients p on p.id = a.patient_id
    where a.clinic_id = demo and a.status = 'completed' and a.start_time >= '2026-09-01' and a.end_time + interval '30 minutes' <= now();
  update appointments a set google_review_sent = true where a.clinic_id = demo and exists (select 1 from communication_log c where c.appointment_id = a.id and c.automation_type = 'review_request' and c.status = 'sent');
  -- SMS log για όσα έφυγαν με SMS
  insert into sms_log (clinic_id, patient_id, appointment_id, sms_type, phone, message, status, sent_at, created_at)
    select c.clinic_id, c.patient_id, c.appointment_id, c.automation_type, c.recipient,
      case c.automation_type
        when 'booking_confirmation' then 'ΤΟ ΡΑΝΤΕΒΟΥ ΣΑΣ ΣΤΟ DEMO CLINIC ΚΛΕΙΣΤΗΚΕ ΓΙΑ ' || upper(to_char(a.start_time at time zone tz, 'DD/MM')) || ' ΣΤΙΣ ' || to_char(a.start_time at time zone tz, 'HH24:MI') || '. ΗΜΕΡΟΛΟΓΙΟ: HTTPS://DEMO.MEDI360.GR/C/AB3XY9'
        when 'confirmation_request' then 'ΥΠΕΝΘΥΜΙΖΟΥΜΕ ΤΟ ΡΑΝΤΕΒΟΥ ΣΑΣ ΣΤΟ DEMO CLINIC ΓΙΑ ' || to_char(a.start_time at time zone tz, 'DD/MM') || ' ΣΤΙΣ ' || to_char(a.start_time at time zone tz, 'HH24:MI') || '. ΕΠΙΒΕΒΑΙΩΣΤΕ: HTTPS://DEMO.MEDI360.GR/C/QW8ZT2'
        when 'instructions' then 'ΟΙ ΟΔΗΓΙΕΣ ΠΡΙΝ ΚΑΙ ΜΕΤΑ ΤΗ ΘΕΡΑΠΕΙΑ ΣΑΣ: HTTPS://DEMO.MEDI360.GR/I/PL4MN7'
        else 'ΕΥΧΑΡΙΣΤΟΥΜΕ ΓΙΑ ΤΗΝ ΕΠΙΣΚΕΨΗ ΣΑΣ ΣΤΟ DEMO CLINIC! ΑΞΙΟΛΟΓΗΣΤΕ ΜΑΣ: HTTPS://G.PAGE/R/DEMO-CLINIC/REVIEW' end,
      'sent', c.created_at, c.created_at
    from communication_log c join appointments a on a.id = c.appointment_id
    where c.clinic_id = demo and c.channel = 'sms' and c.status = 'sent';

  -- ── 10. Δώρα γενεθλίων, pipeline, συσχετίσεις, ιστορικό αλλαγών ──────────
  insert into birthday_gifts (clinic_id, patient_id, year, channel, sent_at, expires_at, gift_value, redeemed_at, redeemed_appointment_id)
    select demo, p.id, 2026, case when p.email is null then 'sms' else 'email' end,
           bday::timestamp at time zone tz + interval '6 hours', bday + 30, 60,
           -- Περίπου οι μισές εξαργυρώνουν το δώρο.
           case when p.i % 2 = 0 then ra.start_time + interval '50 minutes' end,
           case when p.i % 2 = 0 then ra.id end
    from tmp_p p
    cross join lateral (select (p.dob + ((2026 - extract(year from p.dob)::int) || ' years')::interval)::date as bday) b
    left join lateral (select id, start_time from appointments a where a.patient_id = p.id and a.status = 'completed' and a.start_time::date between b.bday + 1 and b.bday + 30 order by a.start_time limit 1) ra on true
    where not p.is_lead and not p.inactive and b.bday between date '2026-06-01' and today - 1
    order by b.bday limit 9;

  insert into pipeline_deals (clinic_id, patient_id, patient_name, phone, service_name, value, stage, probability, source, notes, assigned_to, expected_close, created_at)
    select demo, p.id, p.name, p.phone,
      (array['Fractional CO2 Laser Ουλών Ακμής ×3','Πακέτο 6 συνεδριών Laser — Πόδια Ολόκληρα','Botox Full Face','PRP Τριχωτού ×4','Χαρτογράφηση Σπίλων (οικογένεια, 3 άτομα)','Laser Αφαίρεση Τατουάζ ×6','Skin Boosters (Profhilo) ×2','Botox Υπεριδρωσίας Μασχαλών'])[rn],
      (array[945, 816, 380, 790, 360, 810, 560, 400])[rn],
      (array['lead','lead','consultation','consultation','proposal','won','lost','lead'])[rn],
      (array[20, 20, 40, 40, 60, 100, 0, 20])[rn],
      p.source,
      (array['Ζήτησε τιμή μέσω Instagram','Τηλεφώνησε — θα ξανακαλέσει','Έγινε ενημερωτικό ραντεβού 12/09','Περιμένει απάντηση για δόσεις','Στάλθηκε προσφορά με 10% έκπτωση','Προπλήρωσε πακέτο','Επέλεξε άλλο κέντρο (τιμή)','Παραπομπή από την ' || names[1]])[rn],
      s_admin, today + (array[14, 21, 10, 7, 5, -3, -10, 30])[rn], now() - ((array[3, 9, 12, 6, 15, 30, 25, 1])[rn] || ' days')::interval
    from (select p.*, row_number() over (order by p.i)::int rn from tmp_p p where p.is_lead) p;

  insert into patient_relationships (clinic_id, patient_a_id, patient_b_id, relationship_type)
    select demo, (select id from tmp_p where i = 1), (select id from tmp_p where i = 2), 'Γονέας - Παιδί'
    union all select demo, (select id from tmp_p where i = 3), (select id from tmp_p where i = 4), 'Αδέρφια'
    union all select demo, (select id from tmp_p where i = 51), (select id from tmp_p where i = 9), 'Σύζυγοι';

  insert into activity_log (clinic_id, patient_id, user_id, event_type, event_data, created_at)
    select demo, a.patient_id, (array[s_admin, s_maria, s_sofia, s_nikos])[1 + (random() * 3)::int], 'appointment_status_changed',
           jsonb_build_object('appointment_id', a.id, 'from', 'booked', 'to', a.status, 'start_time', a.start_time, 'service_name', a.service_name),
           a.start_time - ((1 + (random() * 2)::int) || ' days')::interval
    from appointments a where a.clinic_id = demo and a.status in ('cancelled','no_show') and a.start_time >= '2026-08-01' and a.start_time < now();

  -- ── 11. Manifest φωτογραφιών & εξετάσεων (τα αρχεία ανεβάζει η tmp-demo-media) ──
  photo_ts := 1780000000000;
  for pr in
    select a.patient_id, a.id, a.start_time, a.service_name, a.therapist_id, p.i, s.category,
           row_number() over (partition by a.patient_id order by a.start_time desc) rn
    from appointments a join tmp_p p on p.id = a.patient_id join services s on s.clinic_id = demo and s.name = a.service_name
    where a.clinic_id = demo and a.status = 'completed' and a.start_time >= '2026-03-01' and p.i in (2,5,7,9,12,16,19,25,29,52)
      and s.category in (cats[2], cats[3], cats[4])
  loop
    continue when pr.rn > 2;
    for k in 1..2 loop
      photo_ts := photo_ts + 1000 + (random() * 5000)::int;
      insert into patient_photos (clinic_id, patient_id, storage_path, taken_at, uploaded_by, caption, appointment_id, created_at)
      values (demo, pr.patient_id, demo || '/' || pr.patient_id || '/' || photo_ts || '_demo_' || case when k = 1 then 'before' else 'after' end || '.svg',
              pr.start_time + case when k = 1 then interval '0' else interval '50 minutes' end,
              coalesce((select full_name from profiles where id = pr.therapist_id), 'Δρ. Ελένη Παπαδάκη'),
              case when k = 1 then 'Πριν' else 'Μετά' end, pr.id, pr.start_time + interval '55 minutes');
      insert into backup.demo_media_manifest (bucket, path, kind, params)
      values ('patient-photos', demo || '/' || pr.patient_id || '/' || photo_ts || '_demo_' || case when k = 1 then 'before' else 'after' end || '.svg', 'photo',
              jsonb_build_object('label', case when k = 1 then 'ΠΡΙΝ' else 'ΜΕΤΑ' end, 'after', k = 2,
                'service', pr.service_name, 'date', to_char(pr.start_time at time zone tz, 'DD/MM/YYYY'),
                'variant', case when pr.service_name like laser_prefix || '%' then 'laser' else 'face' end, 'seed', pr.i * 10 + pr.rn));
    end loop;
  end loop;

  create temp table tmp_ex (n int, i int, exam_date date, type text, file text, comment text, confirmed boolean, vals jsonb) on commit drop;
  insert into tmp_ex values
    (1, 1, '2026-05-14', 'Γενική Αίματος', 'Geniki_Aimatos_2026-05.svg', 'Ήπια έλλειψη βιταμίνης D. Λοιπές παράμετροι εντός φυσιολογικών ορίων.', true,
      '[["Αιμοσφαιρίνη (Hb)","13.4","g/dL","12.0 – 15.5"],["Αιματοκρίτης (Hct)","40.1","%","36 – 46"],["Λευκά (WBC)","6.2","K/μL","4.0 – 10.5"],["Αιμοπετάλια (PLT)","245","K/μL","150 – 400"],["Σίδηρος (Fe)","78","μg/dL","50 – 170"],["Φερριτίνη","34","ng/mL","15 – 150"],["Γλυκόζη νηστείας","88","mg/dL","70 – 100"],["Βιταμίνη D (25-OH)","24 ↓","ng/mL","30 – 100"]]'),
    (2, 1, '2026-09-02', 'Ιστολογική Εξέταση (Βιοψία Δέρματος)', 'Istologiki_Viopsia_2026-09.svg', 'Καλοήθης σύνθετος μελανοκυτταρικός σπίλος, πλήρως εξαιρεθείς. Δεν απαιτείται περαιτέρω θεραπεία — κλινική παρακολούθηση.', false,
      '[["Εντόπιση","Ράχη, δεξιά ωμοπλάτη","—","—"],["Είδος δείγματος","Εκτομή ατράκτου 8×4 mm","—","—"],["Μακροσκοπικά","Καφέ βλατίδα 5 mm, σαφή όρια","—","—"],["Μικροσκοπικά","Φωλεές μελανοκυττάρων χωρίς ατυπία","—","—"],["Διάγνωση","Σύνθετος μελανοκυτταρικός σπίλος","—","—"],["Όρια εκτομής","Ελεύθερα (> 1 mm)","—","—"],["Κακοήθεια","Δεν ανευρέθη","—","—"],["Σύσταση","Επανέλεγχος χαρτογράφησης σε 12 μήνες","—","—"]]'),
    (3, 3, '2026-04-20', 'Ορμονολογικός Έλεγχος', 'Ormonologikos_2026-04.svg', 'Ορμονολογικός έλεγχος εντός φυσιολογικών ορίων. Δεν προκύπτει αντένδειξη για θεραπείες προσώπου.', true,
      '[["TSH","1.8","μIU/mL","0.4 – 4.0"],["FT4","1.2","ng/dL","0.8 – 1.8"],["Προλακτίνη","14","ng/mL","4 – 23"],["Τεστοστερόνη ολική","38","ng/dL","15 – 70"],["DHEA-S","210","μg/dL","35 – 430"],["Ινσουλίνη νηστείας","9.5","μIU/mL","2.6 – 24.9"],["Οιστραδιόλη (E2)","85","pg/mL","ανάλογα φάσης"],["Βιταμίνη Β12","410","pg/mL","200 – 900"]]'),
    (4, 5, '2026-06-11', 'Βιοχημικός Έλεγχος', 'Vioximikos_2026-06.svg', 'Χαμηλή φερριτίνη — συνιστάται επανέλεγχος σε 3 μήνες.', true,
      '[["Γλυκόζη νηστείας","92","mg/dL","70 – 100"],["HbA1c","5.2","%","< 5.7"],["Χοληστερόλη ολική","176","mg/dL","< 200"],["Τριγλυκερίδια","74","mg/dL","< 150"],["Ουρία","28","mg/dL","15 – 45"],["Κρεατινίνη","0.7","mg/dL","0.5 – 1.1"],["Σίδηρος (Fe)","54","μg/dL","50 – 170"],["Φερριτίνη","12 ↓","ng/mL","15 – 150"]]'),
    (5, 8, '2026-03-03', 'Αλλεργιολογικό Panel', 'Allergiologiko_2026-03.svg', 'Ευαισθησία επαφής στο νικέλιο. Αποφυγή μεταλλικών εργαλείων με νικέλιο κατά τις θεραπείες.', true,
      '[["IgE ολική","142 ↑","IU/mL","< 100"],["Νικέλιο (patch)","Θετικό ++","—","Αρνητικό"],["Άρωμα mix","Αρνητικό","—","Αρνητικό"],["Λανολίνη","Αρνητικό","—","Αρνητικό"],["Παραβένες","Αρνητικό","—","Αρνητικό"],["Ακάρεα σκόνης (d1)","2.4 (κλάση 2)","kU/L","< 0.35"],["Γύρη ελιάς","0.9 (κλάση 2)","kU/L","< 0.35"],["Λάτεξ","Αρνητικό","kU/L","< 0.35"]]'),
    (6, 13, '2026-02-25', 'Γενική Αίματος', 'Geniki_Aimatos_2026-02.svg', 'Οριακή αιμοσφαιρίνη. Λοιπά εντός φυσιολογικών ορίων.', true,
      '[["Αιμοσφαιρίνη (Hb)","12.1","g/dL","12.0 – 15.5"],["Αιματοκρίτης (Hct)","37.0","%","36 – 46"],["Λευκά (WBC)","7.8","K/μL","4.0 – 10.5"],["Αιμοπετάλια (PLT)","310","K/μL","150 – 400"],["MCV","84","fL","80 – 100"],["Σίδηρος (Fe)","61","μg/dL","50 – 170"],["ΤΚΕ","14","mm/h","< 20"],["CRP","0.3","mg/dL","< 0.5"]]'),
    (7, 21, '2026-06-18', 'Δερματολογική Γνωμάτευση', 'Dermatologiki_Gnomateusi_2026-06.svg', 'Καταλληλότητα για πρόγραμμα θεραπειών προσώπου με σαλικυλικό peeling. Χρήση SPF 50 καθημερινά.', true,
      '[["Διάγνωση","Ακμή ήπιας–μέτριας βαρύτητας","—","—"],["Φωτότυπος Fitzpatrick","III","—","—"],["Ενεργός φλεγμονή","Ήπια, παρειές","—","—"],["Αντένδειξη peeling","Όχι","—","—"],["Αντένδειξη laser","Όχι","—","—"],["Σύσταση","Peeling σαλικυλικού 20% ×4, ανά 3 εβδ.","—","—"],["Φαρμακευτική αγωγή","Αδαπαλένη 0.1% βράδυ","—","—"],["Επανεκτίμηση","Σε 3 μήνες","—","—"]]'),
    (8, 34, '2026-07-07', 'Βιταμίνη D & Σίδηρος', 'VitD_Sidiros_2026-07.svg', 'Σιδηροπενική εικόνα και έλλειψη βιταμίνης D. Συνιστάται ιατρική εκτίμηση για συμπλήρωμα.', false,
      '[["Βιταμίνη D (25-OH)","18 ↓","ng/mL","30 – 100"],["Σίδηρος (Fe)","45 ↓","μg/dL","50 – 170"],["Φερριτίνη","9 ↓","ng/mL","15 – 150"],["Τρανσφερρίνη","340","mg/dL","200 – 360"],["Κορεσμός τρανσφερρίνης","13 ↓","%","20 – 50"],["Αιμοσφαιρίνη (Hb)","11.8 ↓","g/dL","12.0 – 15.5"],["Φυλλικό οξύ","7.2","ng/mL","> 4"],["Βιταμίνη Β12","380","pg/mL","200 – 900"]]'),
    (9, 51, '2026-05-12', 'Ορμονολογικός Έλεγχος', 'Ormonologikos_2026-05.svg', 'Εντός φυσιολογικών ορίων. Καμία ορμονική αιτία υπερτρίχωσης.', true,
      '[["Τεστοστερόνη ολική","540","ng/dL","300 – 1000"],["SHBG","32","nmol/L","18 – 54"],["TSH","2.4","μIU/mL","0.4 – 4.0"],["Προλακτίνη","9","ng/mL","4 – 15"],["Κορτιζόλη πρωινή","14","μg/dL","6 – 23"],["DHEA-S","290","μg/dL","80 – 560"],["Γλυκόζη νηστείας","94","mg/dL","70 – 100"],["Βιταμίνη D (25-OH)","31","ng/mL","30 – 100"]]');
  for pr in select e.*, p.id as pid, p.name, p.dob from tmp_ex e join tmp_p p on p.i = e.i order by e.n loop
    insert into patient_exams (clinic_id, patient_id, storage_path, file_name, exam_date, ai_type, ai_summary, ai_status, confirmed, uploaded_by, created_at)
    values (demo, pr.pid, demo || '/' || pr.pid || '/' || (1780000000000 + pr.n * 86400000) || '_' || pr.file, pr.file, pr.exam_date, pr.type, pr.comment, 'done', pr.confirmed, s_admin,
            (pr.exam_date + 1)::timestamp at time zone tz + interval '12 hours');
    insert into backup.demo_media_manifest (bucket, path, kind, params)
    values ('patient-exams', demo || '/' || pr.pid || '/' || (1780000000000 + pr.n * 86400000) || '_' || pr.file, 'exam',
            jsonb_build_object('patient', pr.name, 'dob', to_char(pr.dob, 'DD/MM/YYYY'), 'date', to_char(pr.exam_date, 'DD/MM/YYYY'), 'type', pr.type, 'rows', pr.vals, 'comment', pr.comment));
  end loop;

  -- ── 12. LTV, VIP ──────────────────────────────────────────────────────────
  update patients p set ltv = coalesce((select sum(paid_amount) from appointments a where a.patient_id = p.id and a.status = 'completed'), 0)
                            + coalesce((select sum(amount) from product_sales s where s.patient_id = p.id), 0)
    where p.clinic_id = demo;
  update patients set status = 'vip' where id in (select id from patients where clinic_id = demo and status = 'active' order by ltv desc limit 6);

  raise notice 'demo seed: % appointments', n_appts;
end
$seed$;

-- ── 13. Συστάσεις (referred_by_name / referred_by_patient_id) ─────────────
-- 6 πελάτες συνδεδεμένοι σε 3 «πρεσβευτές» + 3 μόνο με ελεύθερο όνομα (χωρίς καρτέλα).
with amb as (
  select id, full_name, row_number() over (order by id) rn from patients
  where clinic_id='a787b766-9d23-45b2-9660-7bb480856a1b' and status in ('vip','active') order by id limit 3
), tgt as (
  select p.id, row_number() over (order by p.created_at desc) rn from patients p
  where p.clinic_id='a787b766-9d23-45b2-9660-7bb480856a1b' and p.status='active' and p.id not in (select id from amb)
  order by p.created_at desc limit 9
)
update patients p set
  source = 'Σύσταση',
  referred_by_name = case when t.rn <= 6 then initcap(lower(a.full_name)) else (array['Ελένη Κωνσταντίνου','Μαρία Νικολάου','Γιώργος Παππάς'])[t.rn-6] end,
  referred_by_patient_id = case when t.rn <= 6 then a.id else null end
from tgt t left join amb a on a.rn = ((t.rn-1) % 3) + 1
where p.id = t.id and t.rn <= 9;

-- Έλεγχος:
--   select status, count(*) from appointments where clinic_id='a787b766-9d23-45b2-9660-7bb480856a1b' group by 1;
--   select kind, count(*), count(uploaded_at) from backup.demo_media_manifest group by 1;

-- ── 14. Δωμάτια (clinic_rooms) + προεπιλογή ανά κατηγορία + backfill ραντεβού ──
insert into public.clinic_rooms (clinic_id, name, color, sort_order)
select 'a787b766-9d23-45b2-9660-7bb480856a1b', r.name, r.color, r.ord
from (values ('Ιατρείο 1', '#1F6F8B', 1), ('Ιατρείο 2', '#7C3AED', 2), ('Laser', '#C2410C', 3), ('Αισθητική', '#0F6E56', 4)) as r(name, color, ord)
where not exists (select 1 from public.clinic_rooms where clinic_id='a787b766-9d23-45b2-9660-7bb480856a1b');
update public.services s set default_room_id = r.id
from public.clinic_rooms r
where s.clinic_id='a787b766-9d23-45b2-9660-7bb480856a1b' and r.clinic_id = s.clinic_id and s.default_room_id is null
  and r.name = case s.category
    when 'Ιατρική Δερματολογία' then 'Ιατρείο 1' when 'Ενέσιμες Θεραπείες' then 'Ιατρείο 2'
    when 'Laser & Συσκευές' then 'Laser' when 'Peelings & Ιατρική Αισθητική' then 'Αισθητική' end;
update public.appointments a set room_id = s.default_room_id
from public.services s
where a.clinic_id='a787b766-9d23-45b2-9660-7bb480856a1b' and s.clinic_id = a.clinic_id and s.name = a.service_name
  and a.room_id is null and s.default_room_id is not null;

-- ── 15. Κρίσιμες πληροφορίες πελατών (banner/pop-up) ──────────────────────────
update public.patients set critical_note = case full_name
  when 'ΚΑΤΕΡΙΝΑ ΟΙΚΟΝΟΜΟΥ' then 'Δικηγόρος, εξειδικευμένη σε GDPR — πολύ αυστηρή με προσωπικά δεδομένα. Καμία αναφορά σε τρίτους, καμία φωτογραφία χωρίς ρητή άδεια.'
  when 'ΜΑΡΙΑ ΠΑΠΑΔΟΠΟΥΛΟΥ' then 'VIP — θέλει ραντεβού μόνο με Δρ. Παπαδάκη. Δεν περιμένει στην αίθουσα αναμονής, να περνάει κατευθείαν.'
  when 'ΝΙΚΟΣ ΚΑΡΑΓΙΑΝΝΗΣ' then 'Αργεί συστηματικά 15–20 λεπτά. Να κλείνεται πάντα τελευταίο ραντεβού της ζώνης.'
  when 'ΔΕΣΠΟΙΝΑ ΧΑΤΖΗ' then 'Σοβαρή αλλεργία στη λιδοκαΐνη — ΟΧΙ τοπική αναισθησία με λιδοκαΐνη. Έχει ενημερωθεί το ιατρικό ιστορικό.'
  when 'ΕΛΕΥΘΕΡΙΑ ΣΑΜΑΡΑ' then 'Ακυρώνει συχνά την τελευταία στιγμή — επιβεβαίωση τηλεφωνικά την προηγούμενη μέρα, όχι SMS μόνο.'
  else critical_note end,
  arrives_late = full_name in ('ΝΙΚΟΣ ΚΑΡΑΓΙΑΝΝΗΣ','ΦΑΙΗ ΚΑΤΣΑΡΟΥ')
where clinic_id='a787b766-9d23-45b2-9660-7bb480856a1b';

-- ── 16. Εξέταση από email που ΜΠΛΟΚΑΡΙΣΤΗΚΕ λόγω έλλειψης GDPR ─────────────────
-- (το exam-ingest καταγράφει event 'exam_blocked_no_gdpr' — φαίνεται ως banner
--  στην καρτέλα Εξετάσεις του ασθενή μέχρι να υπογράψει τη Φόρμα Ιστορικού)
with p as (
  select id, email from public.patients
  where clinic_id='a787b766-9d23-45b2-9660-7bb480856a1b' and gdpr_signed=false and email is not null
  order by full_name limit 1
)
insert into public.activity_log (clinic_id, patient_id, event_type, event_data, created_at)
select 'a787b766-9d23-45b2-9660-7bb480856a1b', p.id, 'exam_blocked_no_gdpr',
       jsonb_build_object('filename','Γενική_Αίματος_2026-09.pdf','sender_email',p.email,'message_id','demo-msg-1'),
       now() - interval '2 days'
from p
where not exists (select 1 from public.activity_log a where a.patient_id=p.id and a.event_type='exam_blocked_no_gdpr');
