// ════════════════════════════════════════════════════════════════════════════
//  seed-static-choodasandra.js
//  Static seed: writes curated venues across all 5 categories at distances
//  of ~1 km, ~2 km, ~3 km, ~5 km, ~10 km and ~25 km from Choodasandra,
//  Bangalore (lat 12.883679, lng 77.679381) using real lat/lng offsets.
//
//  Run:  node seed-static-choodasandra.js
//        node seed-static-choodasandra.js --wipe   ← deletes existing static docs first
// ════════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}
initializeApp({ credential: cert(serviceAccount) });
const db        = getFirestore();
const venuesCol = db.collection('venues');

// ── Centre point ─────────────────────────────────────────────────────────────
// Choodasandra, Bangalore
// 1° lat  ≈ 111.32 km  →  1 km ≈ 0.008983°
// 1° lng  ≈ 108.52 km  →  1 km ≈ 0.009215°  (at lat 12.88°)
const C = { lat: 12.883679, lng: 77.679381 };

// ── Venue catalogue ───────────────────────────────────────────────────────────
// Each entry: [id_suffix, name, category, address, hours, capacity, lat, lng]
// Coordinates computed so that haversine(C, venue) ≈ stated distance.
const VENUES = [

  // ── SALONS  (capacity 6) ──────────────────────────────────────────────────
  // ~1 km
  ['sal_01', 'Style Hub Salon',         'salon', '14, HSR Layout Sector 1, Bangalore',          '9:00 AM – 8:00 PM', 6,  12.8927, 77.6794],
  ['sal_02', 'Gorgeous Cuts',           'salon', '22, Choodasandra Main Rd, Bangalore',         '10:00 AM – 7:00 PM', 6, 12.8837, 77.6886],
  // ~2 km
  ['sal_03', 'The Grooming Studio',     'salon', '8, Koramangala 3rd Block, Bangalore',         '9:30 AM – 8:30 PM', 6,  12.8964, 77.6924],
  ['sal_04', 'Lakmé Salon HSR',         'salon', '45, 27th Main, HSR Layout, Bangalore',       '10:00 AM – 8:00 PM', 6, 12.8709, 77.6664],
  // ~3 km
  ['sal_05', 'Urban Scissors',          'salon', '101, Agara Village, HSR Layout, Bangalore',   '9:00 AM – 9:00 PM', 6,  12.9028, 77.6984],
  ['sal_06', 'Green Trends Salon',      'salon', '12, Bommanahalli Main Rd, Bangalore',         '10:00 AM – 8:00 PM', 6, 12.8567, 77.6794],
  // ~5 km
  ['sal_07', 'Naturals Hair & Beauty',  'salon', '3, Sarjapur Rd, Kasavanahalli, Bangalore',    '9:00 AM – 8:00 PM', 6,  12.9287, 77.6794],
  ['sal_08', 'Enrich Salon Whitefield', 'salon', '78, Whitefield Main Rd, Bangalore',           '10:00 AM – 9:00 PM', 6, 12.8837, 77.7254],
  // ~10 km
  ['sal_09', 'Streaks Salon Indiranagar','salon','12, 100 Feet Rd, Indiranagar, Bangalore',     '9:00 AM – 8:00 PM', 6,  12.9737, 77.6794],
  ['sal_10', 'Tony & Guy Jayanagar',    'salon', '41, 11th Main, Jayanagar 4th Block, Bangalore','10:00 AM – 7:30 PM', 6,12.8201, 77.6144],
  // ~25 km
  ['sal_11', 'VLCC Beauty Yeshwanthpur','salon', '18, Tumkur Rd, Yeshwanthpur, Bangalore',      '9:00 AM – 8:00 PM', 6,  13.1087, 77.6794],
  ['sal_12', 'Bounce Salon Hebbal',     'salon', '5, Outer Ring Rd, Hebbal, Bangalore',         '10:00 AM – 8:00 PM', 6, 13.0425, 77.8369],

  // ── RESTAURANTS  (capacity 20) ────────────────────────────────────────────
  // ~1 km
  ['res_01', 'Dosa Corner',             'restaurant', '3, 5th Cross, Choodasandra, Bangalore',   '7:00 AM – 10:00 PM', 20, 12.8900, 77.6710],
  ['res_02', 'Biryani House',           'restaurant', '27, HSR Sector 2, Bangalore',              '11:00 AM – 11:00 PM', 20,12.8773, 77.6857],
  // ~2 km
  ['res_03', 'The Spice Garden',        'restaurant', '14, Koramangala 5th Block, Bangalore',    '12:00 PM – 11:00 PM', 20,12.8964, 77.6924],
  ['res_04', 'Punjabi Tadka',           'restaurant', '9, 24th Main, HSR Layout, Bangalore',     '11:00 AM – 11:00 PM', 20,12.8709, 77.6664],
  // ~3 km
  ['res_05', 'South Indian Kitchen',    'restaurant', '56, 80 Feet Rd, Koramangala, Bangalore',  '7:30 AM – 10:30 PM', 20, 12.8837, 77.7070],
  ['res_06', 'Chinese Dragon',          'restaurant', '33, Bommanahalli, Bangalore',              '12:00 PM – 10:30 PM', 20,12.8647, 77.6989],
  // ~5 km
  ['res_07', 'Barbeque Nation Koramangala','restaurant','298, 80 Feet Rd, Koramangala, Bangalore','12:00 PM – 11:30 PM',20,12.9287, 77.6794],
  ['res_08', 'Meghana Foods Sarjapur',  'restaurant', '14, Sarjapur Main Rd, Bangalore',         '11:30 AM – 11:00 PM', 20,12.8519, 77.7118],
  // ~10 km
  ['res_09', 'MTR Restaurant Indiranagar','restaurant','11, Swami Vivekananda Rd, Indiranagar',  '6:30 AM – 9:00 PM', 20,  12.9737, 77.6794],
  ['res_10', 'Vidyarthi Bhavan Jayanagar','restaurant','32, Gandhi Bazaar, Basavanagudi',        '6:30 AM – 1:30 PM', 20,  12.9473, 77.6144],
  // ~25 km
  ['res_11', 'Empire Restaurant MG Rd', 'restaurant', '36, Church St, MG Road, Bangalore',       '12:00 PM – 1:00 AM', 20, 13.1087, 77.6794],
  ['res_12', 'Karavalli Taj West End',  'restaurant', '25, Race Course Rd, Bangalore',            '12:30 PM – 3:00 PM', 20, 12.6587, 77.6794],

  // ── CLINICS  (capacity 15) ────────────────────────────────────────────────
  // ~1 km
  ['cli_01', 'Apollo Clinic HSR',       'clinic', '8, Sector 2, HSR Layout, Bangalore',          '8:00 AM – 8:00 PM', 15, 12.8837, 77.6886],
  ['cli_02', 'HealthFirst Clinic',      'clinic', '2nd Cross, Choodasandra, Bangalore',           '9:00 AM – 7:00 PM', 15, 12.8927, 77.6794],
  // ~2 km
  ['cli_03', 'Dr. Sharma\'s Clinic',    'clinic', '17, 27th Main, HSR Layout, Bangalore',        '9:00 AM – 6:00 PM', 15, 12.8709, 77.6664],
  ['cli_04', 'Medix Health Centre',     'clinic', '40, Koramangala 6th Block, Bangalore',        '8:30 AM – 8:30 PM', 15, 12.8964, 77.6924],
  // ~3 km
  ['cli_05', 'City Care Clinic',        'clinic', '5, Agara Lake Rd, HSR Layout, Bangalore',     '9:00 AM – 8:00 PM', 15, 12.9028, 77.6984],
  ['cli_06', 'Manipal Clinic Bommanahalli','clinic','11, Hosur Rd, Bommanahalli, Bangalore',     '8:00 AM – 9:00 PM', 15, 12.8567, 77.6794],
  // ~5 km
  ['cli_07', 'Fortis Clinic Bannerghatta','clinic','154/9, Bannerghatta Rd, Bangalore',          '8:00 AM – 8:00 PM', 15, 12.8387, 77.6794],
  ['cli_08', 'Columbia Asia Clinic',    'clinic', '26/4, Brigade Gateway, Whitefield, Bangalore','8:00 AM – 8:00 PM', 15, 12.8837, 77.7254],
  // ~10 km
  ['cli_09', 'Narayana Clinic Indiranagar','clinic','80 Feet Rd, Indiranagar, Bangalore',       '8:00 AM – 8:00 PM', 15, 12.9473, 77.7444],
  ['cli_10', 'Sakra Premium Clinic',    'clinic', 'Marathahalli Bridge, Bangalore',              '8:00 AM – 9:00 PM', 15, 12.9201, 77.7444],
  // ~25 km
  ['cli_11', 'BGS Hospital Uttarahalli','clinic', 'Uttarahalli Main Rd, Bangalore',              '24 hours', 15,          12.8201, 77.5144],
  ['cli_12', 'Aster CMI Hospital Hebbal','clinic','43/2, NH 44, Hebbal, Bangalore',             '24 hours', 15,          13.0425, 77.5969],

  // ── GYMS  (capacity 40) ───────────────────────────────────────────────────
  // ~1 km
  ['gym_01', 'Gold\'s Gym HSR Layout',   'gym', '1st Floor, 19th Main, HSR Layout, Bangalore',  '5:00 AM – 11:00 PM', 40, 12.8773, 77.6857],
  ['gym_02', 'FitLife Studio',           'gym', '7, 7th Cross, Choodasandra, Bangalore',         '5:30 AM – 10:00 PM', 40, 12.8927, 77.6886],
  // ~2 km
  ['gym_03', 'Cult.fit HSR',             'gym', 'Ground Floor, 27th Main, HSR Layout, Bangalore','6:00 AM – 10:00 PM', 40, 12.8709, 77.6664],
  ['gym_04', 'Fitness First Koramangala','gym', '100 Feet Rd, Koramangala 4th Block, Bangalore', '5:00 AM – 11:00 PM', 40, 12.8964, 77.6924],
  // ~3 km
  ['gym_05', 'CrossFit Koramangala',     'gym', '5th Block, Koramangala, Bangalore',             '6:00 AM – 9:00 PM', 40,  12.9028, 77.6984],
  ['gym_06', 'Iron Paradise Gym',        'gym', 'Bommanahalli, Hosur Rd, Bangalore',             '5:00 AM – 10:00 PM', 40, 12.8647, 77.6989],
  // ~5 km
  ['gym_07', 'Anytime Fitness Bannerghatta','gym','Bannerghatta Rd, JP Nagar, Bangalore',        '24 hours', 40,          12.8519, 77.7118],
  ['gym_08', 'Snap Fitness Sarjapur',    'gym', 'Sarjapur Rd, Bellandur, Bangalore',             '5:00 AM – 11:00 PM', 40, 12.9155, 77.6470],
  // ~10 km
  ['gym_09', 'Talwalkars Indiranagar',   'gym', '100 Feet Rd, Indiranagar, Bangalore',           '6:00 AM – 10:00 PM', 40, 12.9737, 77.6794],
  ['gym_10', 'O2 Fitness Jayanagar',     'gym', '9th Block, Jayanagar, Bangalore',               '5:30 AM – 10:30 PM', 40, 12.8201, 77.6144],
  // ~25 km
  ['gym_11', 'Gold\'s Gym Whitefield',   'gym', 'Whitefield Main Rd, ITPL, Bangalore',           '5:00 AM – 11:00 PM', 40, 13.0425, 77.8369],
  ['gym_12', 'Cult.fit Hebbal',          'gym', 'Outer Ring Rd, Hebbal, Bangalore',               '6:00 AM – 10:00 PM', 40, 13.1087, 77.6794],

  // ── CAFES  (capacity 15) ──────────────────────────────────────────────────
  // ~1 km
  ['caf_01', 'Third Wave Coffee HSR',    'cafe', '18th Main, HSR Layout Sector 4, Bangalore',    '7:00 AM – 11:00 PM', 15, 12.8927, 77.6794],
  ['caf_02', 'Café Coffee Day Choodasandra','cafe','1, Choodasandra Main Rd, Bangalore',         '8:00 AM – 10:00 PM', 15, 12.8837, 77.6886],
  // ~2 km
  ['caf_03', 'Starbucks Koramangala',    'cafe', '4th Block, Koramangala, Bangalore',            '7:00 AM – 11:00 PM', 15, 12.8964, 77.6924],
  ['caf_04', 'Blue Tokai HSR',           'cafe', '27th Main, HSR Layout, Bangalore',             '8:00 AM – 9:00 PM', 15, 12.8709, 77.6664],
  // ~3 km
  ['caf_05', 'Matteo Coffea',            'cafe', '80 Feet Rd, Koramangala 4th Block, Bangalore', '8:00 AM – 10:00 PM', 15, 12.9028, 77.6598],
  ['caf_06', 'The Coffee Bean Bommanahalli','cafe','Hosur Rd, Bommanahalli, Bangalore',          '8:00 AM – 10:00 PM', 15, 12.8647, 77.6989],
  // ~5 km
  ['caf_07', 'Roastery Coffee House',    'cafe', 'Sarjapur Rd, Kasavanahalli, Bangalore',        '8:00 AM – 10:00 PM', 15, 12.9287, 77.6794],
  ['caf_08', 'Brewworks Cafe Whitefield','cafe', 'Whitefield Main Rd, Bangalore',                '9:00 AM – 11:00 PM', 15, 12.8837, 77.7254],
  // ~10 km
  ['caf_09', 'Dyu Art Café Koramangala', 'cafe', '23, 8th Cross, Koramangala, Bangalore',        '8:30 AM – 10:30 PM', 15, 12.9473, 77.7444],
  ['caf_10', 'Koshy\'s Cafe',            'cafe', '39, St. Marks Rd, Bangalore',                  '9:00 AM – 11:00 PM', 15, 12.9737, 77.6794],
  // ~25 km
  ['caf_11', 'Café Noir Hebbal',         'cafe', 'Outer Ring Rd, Hebbal, Bangalore',             '8:00 AM – 11:00 PM', 15, 13.0425, 77.8369],
  ['caf_12', 'InstaCuppa Yeshwanthpur',  'cafe', 'Tumkur Rd, Yeshwanthpur, Bangalore',           '7:00 AM – 10:00 PM', 15, 13.1087, 77.6794],
];

// ── Haversine distance check (for logging) ───────────────────────────────────
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function wipeStatic() {
  const snap = await venuesCol.get();
  let n = 0;
  for (const doc of snap.docs) {
    if (doc.id.startsWith('static_')) { await doc.ref.delete(); n++; }
  }
  console.log(`Wiped ${n} previously-seeded static venues.`);
}

(async () => {
  const wipe = process.argv.includes('--wipe');
  if (wipe) await wipeStatic();

  console.log(`Seeding ${VENUES.length} venues near Choodasandra...\n`);
  const counts = { salon: 0, restaurant: 0, clinic: 0, gym: 0, cafe: 0 };

  for (const [suffix, name, category, address, hours, capacity, latitude, longitude] of VENUES) {
    const id  = `static_${suffix}`;
    const dist = distanceKm(C.lat, C.lng, latitude, longitude).toFixed(2);
    const doc = {
      id, name, category, address, hours, capacity,
      count:     0,
      latitude,
      longitude,
      ownerId:   null,
      source:    'static',
      createdAt: Date.now(),
    };
    await venuesCol.doc(id).set(doc, { merge: true });
    counts[category]++;
    console.log(`  ✓ [${dist} km]  ${name}  (${category})`);
  }

  console.log('\n──────── Seed complete ────────');
  Object.entries(counts).forEach(([cat, n]) => console.log(`  ${cat.padEnd(12)}: ${n}`));
  console.log(`  ${'TOTAL'.padEnd(12)}: ${VENUES.length}`);
  process.exit(0);
})().catch(e => { console.error('Seed failed:', e); process.exit(1); });
