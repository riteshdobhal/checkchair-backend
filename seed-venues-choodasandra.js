// ════════════════════════════════════════════════════════════════════════════
//  seed-venues-choodasandra.js
//  One-time seed: pull nearby businesses (salons, cafes, gyms, restaurants,
//  clinics) within 5 km of Choodasandra, Bangalore from OpenStreetMap
//  (Overpass API — no key, no billing) and write them into the `venues`
//  Firestore collection in the shape the FreeChair app expects.
//
//  Run:  node seed-venues-choodasandra.js
//  Re-runnable: uses deterministic ids, so re-running updates instead of
//  duplicating. Pass --wipe to delete all seeded docs first.
// ════════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');

// ── Firebase init (reuses your existing credentials) ────────────────────────
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const venuesCol = db.collection('venues');

// ── Search config ───────────────────────────────────────────────────────────
const CENTER = { lat: 12.883679, lng: 77.679381 };  // Choodasandra, Bangalore
const RADIUS_M = 5000;                                // 5 km

// Default capacity per category (matches your categories.ts)
const DEFAULT_CAP = { salon: 6, restaurant: 20, clinic: 15, gym: 40, cafe: 15 };

// Map your category id → the OSM tag filters that identify it.
// Each entry is an array of [key, value] OSM tag pairs to match (OR'd together).
const CATEGORY_OSM = {
  salon:      [['shop', 'hairdresser'], ['shop', 'beauty'], ['amenity', 'beauty_salon']],
  cafe:       [['amenity', 'cafe']],
  gym:        [['leisure', 'fitness_centre'], ['leisure', 'sports_centre']],
  restaurant: [['amenity', 'restaurant'], ['amenity', 'fast_food']],
  clinic:     [['amenity', 'clinic'], ['amenity', 'doctors'], ['amenity', 'hospital']],
};

// ── Build one Overpass query covering all categories at once ────────────────
function buildOverpassQuery() {
  const parts = [];
  for (const pairs of Object.values(CATEGORY_OSM)) {
    for (const [k, v] of pairs) {
      // node + way + relation, within radius of center
      parts.push(`node["${k}"="${v}"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});`);
      parts.push(`way["${k}"="${v}"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});`);
    }
  }
  return `[out:json][timeout:60];(${parts.join('')});out center tags;`;
}

// Given an OSM element's tags, decide which of our categories it belongs to.
function categoryOf(tags) {
  for (const [catId, pairs] of Object.entries(CATEGORY_OSM)) {
    for (const [k, v] of pairs) {
      if (tags[k] === v) return catId;
    }
  }
  return null;
}

// Build a readable address from whatever OSM address tags exist.
function addressOf(tags) {
  const parts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:suburb'] || tags['addr:neighbourhood'],
    tags['addr:city'],
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Address not set';
}

// Deterministic, Firestore-safe doc id so re-runs update instead of duplicate.
function venueId(el) {
  return `osm_${el.type}_${el.id}`;
}

async function fetchOverpass(query) {
  // Multiple mirrors — if one is busy/blocking, try the next.
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass returns 406 without a proper User-Agent.
          'User-Agent': 'FreeChair-seed/1.0 (contact: dev@example.com)',
          'Accept': '*/*',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) { lastErr = new Error(`Overpass HTTP ${res.status} at ${url}`); continue; }
      return res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All Overpass endpoints failed');
}

async function wipeSeeded() {
  const snap = await venuesCol.get();
  let n = 0;
  for (const doc of snap.docs) {
    if (doc.id.startsWith('osm_')) { await doc.ref.delete(); n++; }
  }
  console.log(`Wiped ${n} previously-seeded venues.`);
}

(async () => {
  const wipe = process.argv.includes('--wipe');
  if (wipe) await wipeSeeded();

  console.log(`Querying OpenStreetMap within ${RADIUS_M / 1000} km of Choodasandra...`);
  const data = await fetchOverpass(buildOverpassQuery());
  const elements = data.elements || [];
  console.log(`Overpass returned ${elements.length} raw elements.`);

  const counts = { salon: 0, cafe: 0, gym: 0, restaurant: 0, clinic: 0, skipped: 0 };
  let written = 0;

  for (const el of elements) {
    const tags = el.tags || {};
    const name = tags.name;
    if (!name) { counts.skipped++; continue; }   // skip unnamed POIs

    const category = categoryOf(tags);
    if (!category) { counts.skipped++; continue; }

    // node has lat/lon directly; way/relation has it under `center`
    const lat = el.lat ?? el.center?.lat ?? null;
    const lng = el.lon ?? el.center?.lon ?? null;

    const doc = {
      id:        venueId(el),
      name,
      category,                                   // real category id: salon/cafe/gym/...
      address:   addressOf(tags),
      hours:     tags.opening_hours || 'Hours not set',
      capacity:  DEFAULT_CAP[category] || 6,
      count:     0,                               // no live data — owner-updated later
      lat, lng,
      ownerId:   null,                            // unclaimed (seed data)
      source:    'osm',
      createdAt: Date.now(),
    };

    await venuesCol.doc(doc.id).set(doc, { merge: true });
    counts[category]++;
    written++;
  }

  console.log('\n──────── Seed complete ────────');
  console.log(`  salons:      ${counts.salon}`);
  console.log(`  cafes:       ${counts.cafe}`);
  console.log(`  gyms:        ${counts.gym}`);
  console.log(`  restaurants: ${counts.restaurant}`);
  console.log(`  clinics:     ${counts.clinic}`);
  console.log(`  skipped (unnamed/unmatched): ${counts.skipped}`);
  console.log(`  TOTAL written to venues: ${written}`);
  process.exit(0);
})().catch(e => { console.error('Seed failed:', e); process.exit(1); });
