// Seeds venues for NCR region (Delhi, Gurgaon, Noida area)
require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');

const sa = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./serviceAccountKey.json');
initializeApp({ credential: cert(sa) });
const db        = getFirestore();
const venuesCol = db.collection('venues');

// Central Delhi coordinates, 15 km radius to cover Delhi + Gurgaon + Noida
const LAT = 28.6139, LNG = 77.2090, RADIUS_M = 15000;

const CATEGORY_OSM = {
  salon:      [['shop','hairdresser'],['shop','beauty'],['amenity','beauty_salon']],
  cafe:       [['amenity','cafe']],
  gym:        [['leisure','fitness_centre'],['leisure','sports_centre']],
  restaurant: [['amenity','restaurant'],['amenity','fast_food']],
  clinic:     [['amenity','clinic'],['amenity','doctors'],['amenity','hospital']],
};
const DEFAULT_CAP = { salon:6, restaurant:20, clinic:15, gym:40, cafe:15 };

function buildQuery() {
  const parts = [];
  for (const pairs of Object.values(CATEGORY_OSM))
    for (const [k,v] of pairs) {
      parts.push(`node["${k}"="${v}"](around:${RADIUS_M},${LAT},${LNG});`);
      parts.push(`way["${k}"="${v}"](around:${RADIUS_M},${LAT},${LNG});`);
    }
  return `[out:json][timeout:60];(${parts.join('')});out center tags;`;
}

function categoryOf(tags) {
  for (const [catId,pairs] of Object.entries(CATEGORY_OSM))
    for (const [k,v] of pairs) if (tags[k]===v) return catId;
  return null;
}

function addressOf(tags) {
  return [tags['addr:housenumber'],tags['addr:street'],
    tags['addr:suburb']||tags['addr:neighbourhood'],tags['addr:city'],
  ].filter(Boolean).join(', ') || 'Address not set';
}

(async () => {
  console.log(`Querying OpenStreetMap: ${RADIUS_M/1000} km around Delhi (${LAT}, ${LNG})...`);
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  let data;
  for (const url of ENDPOINTS) {
    try {
      console.log(' Trying', url);
      const r = await fetch(url, {
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'CheckChair/1.0'},
        body:'data='+encodeURIComponent(buildQuery()),
      });
      if (r.ok) { data = await r.json(); console.log(' OK'); break; }
      else console.log(' HTTP', r.status);
    } catch(e) { console.log(' Error:', e.message); }
  }
  if (!data) { console.error('All Overpass endpoints failed'); process.exit(1); }

  const elements = data.elements || [];
  console.log(`\nOSM elements returned: ${elements.length}`);

  const counts = { salon:0, restaurant:0, clinic:0, gym:0, cafe:0 };
  let skipped = 0;

  for (const el of elements) {
    const tags = el.tags || {};
    const name = tags.name;
    if (!name) { skipped++; continue; }
    const category = categoryOf(tags);
    if (!category) { skipped++; continue; }
    const lat = el.lat ?? el.center?.lat ?? null;
    const lng = el.lon ?? el.center?.lon ?? null;
    // India bounding box guard
    if (lat == null || lat < 8 || lat > 37 || lng < 68 || lng > 97) { skipped++; continue; }

    const id = `osm_${el.type}_${el.id}`;
    await venuesCol.doc(id).set({
      id, name, category,
      address:   addressOf(tags),
      hours:     tags.opening_hours || 'Hours not set',
      capacity:  DEFAULT_CAP[category] || 6,
      count:     0, latitude: lat, longitude: lng,
      ownerId:   null, source: 'osm', createdAt: Date.now(),
    }, { merge: true });
    counts[category]++;
  }

  const total = Object.values(counts).reduce((a,b)=>a+b,0);
  console.log('\n──── NCR seed complete ────');
  Object.entries(counts).forEach(([c,n]) => console.log(`  ${c.padEnd(12)}: ${n}`));
  console.log(`  ${'skipped'.padEnd(12)}: ${skipped}`);
  console.log(`  ${'TOTAL'.padEnd(12)}: ${total}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
