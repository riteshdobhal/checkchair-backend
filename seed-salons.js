/**
 * seed-salons.js
 * Bulk-uploads real salons near Choodasandra into Firestore.
 *
 * HOW TO RUN:
 *   1. Place this file in your backend folder (next to server.js)
 *   2. Make sure serviceAccountKey.json is in the same folder
 *   3. Run:  node seed-salons.js
 *
 * It creates one document per salon in the "salons" collection.
 * Safe to re-run — it overwrites by salonId (no duplicates).
 */

const admin = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { initializeApp, cert } = require('firebase-admin/app');

const serviceAccount = require('./serviceAccountKey.json');
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// Helper — turn "10:00 AM – 9:00 PM" style into a simple label
const hoursLabel = (todayHours) => todayHours || 'Hours vary';

// 14 real salons within ~3km of Choodasandra
const salons = [
  { id: 'sal_yellowdoor',   name: 'The Yellow Door Unisex Salon', address: 'Choodasandra Rd, opp. InnerSpaces Glory Fields, Choodasandra', hours: 'Daily 10 AM – 9 PM',   capacity: 8,  lat: 12.8883855, lng: 77.6777039, phone: '+918792223489', rating: 4.7, type: 'unisex' },
  { id: 'sal_trends',       name: 'The Trends Unisex Salon',      address: 'Green Valley Layout, MJ Nagar Rd, Choodasandra',              hours: 'Daily 9 AM – 10 PM',  capacity: 6,  lat: 12.8855888, lng: 77.6808960, phone: '+917022031578', rating: 4.9, type: 'unisex' },
  { id: 'sal_stylemantra',  name: 'Style Mantra Unisex Salon',    address: 'MDR Building, Kasavanahalli Main Rd, Choodasandra',            hours: 'Daily 10 AM – 8:30 PM', capacity: 8, lat: 12.8930141, lng: 77.6740232, phone: '+919663623559', rating: 4.8, type: 'unisex' },
  { id: 'sal_modish',       name: 'Modish Family Salon',          address: 'ASR Avenue, Kasavanahalli Main Rd, Amrita Nagar',             hours: 'Daily 9 AM – 9 PM',   capacity: 8,  lat: 12.8928290, lng: 77.6739191, phone: '+919844332220', rating: 4.7, type: 'unisex' },
  { id: 'sal_aabha',        name: 'Aabha Women Care Salon',       address: 'Choodasandra, K.G.Cudasandra',                                hours: 'Daily 10:30 AM – 8 PM', capacity: 6, lat: 12.8885607, lng: 77.6808259, phone: '+916356351616', rating: 4.8, type: 'women' },
  { id: 'sal_sfy',          name: 'SFY Unisex Salon',             address: 'Choodasandra Rd, near Amrita College, Amrita Nagar',          hours: 'Daily 9 AM – 9 PM',   capacity: 6,  lat: 12.8943873, lng: 77.6774717, phone: '+919113592947', rating: 4.6, type: 'unisex' },
  { id: 'sal_s2classic',    name: 'S2 Classic Mens Salon',        address: 'Nagara Kallu Temple, Choodasandra Rd, Kasavanahalli',         hours: 'Daily 8 AM – 10 PM',  capacity: 5,  lat: 12.8884026, lng: 77.6770625, phone: '',             rating: 4.8, type: 'men' },
  { id: 'sal_haircraft',    name: "Hair Craft Men's Salon",       address: 'Doddamara Rd, near Notre Dame School, Choodasandra',          hours: 'Daily 8 AM – 9:30 PM', capacity: 5, lat: 12.8819121, lng: 77.6812253, phone: '+918475906263', rating: 4.9, type: 'men' },
  { id: 'sal_mrbarber',     name: "Mr Barber Men's Salon",        address: 'Doddamara Rd, opp. Notre Dame Academy, Choodasandra',         hours: 'Daily 7:30 AM – 8:30 PM', capacity: 5, lat: 12.8820413, lng: 77.6793934, phone: '', rating: 4.7, type: 'men' },
  { id: 'sal_a2s',          name: "A2S Men's Saloon",             address: 'Doodamara Road, Rayasandra Huskur Post, Choodasandra',        hours: 'Daily 8 AM – 10 PM',  capacity: 4,  lat: 12.8811763, lng: 77.6777056, phone: '+918496994436', rating: 5.0, type: 'men' },
  { id: 'sal_fusion',       name: 'Fusion Unisex Salon',          address: 'SNS Complex, opp. Mahaveer Ranches, Balaji Layout',           hours: 'Daily 9 AM – 9 PM',   capacity: 6,  lat: 12.8783669, lng: 77.6724086, phone: '+919632220359', rating: 5.0, type: 'unisex' },
  { id: 'sal_hangkhim',     name: 'Hangkhim Hair & Beauty Salon', address: '1st St, Choodasandra, K.G.Cudasandra',                        hours: 'Daily 10 AM – 9 PM',  capacity: 4,  lat: 12.8884640, lng: 77.6787574, phone: '',             rating: 5.0, type: 'unisex' },
  { id: 'sal_rekha',        name: "Rekha's Beauty Salon",         address: '5th A Cross, Meenakshi Layout, Choodasandra',                 hours: 'Daily 10:30 AM – 8:30 PM', capacity: 4, lat: 12.8820580, lng: 77.6754045, phone: '+919148910771', rating: 5.0, type: 'women' },
  { id: 'sal_c27',          name: 'C27 Beauty Salon & Makeup',    address: 'GR Homes, Meenakshi Layout, Choodasandra',                    hours: 'Daily 9 AM – 9:30 PM', capacity: 5, lat: 12.8833586, lng: 77.6746319, phone: '+917483419675', rating: 4.9, type: 'women' },
];

async function seed() {
  console.log(`\nSeeding ${salons.length} salons into Firestore...\n`);
  const batch = db.batch();

  for (const s of salons) {
    const ref = db.collection('salons').doc(s.id);
    batch.set(ref, {
      id:        s.id,
      name:      s.name,
      address:   s.address,
      hours:     s.hours,
      capacity:  s.capacity,
      count:     0,                    // starts empty
      ownerId:   '',                   // no owner yet — admin seeded
      location:  { lat: s.lat, lng: s.lng },
      phone:     s.phone,
      rating:    s.rating,
      type:      s.type,               // men / women / unisex
      seeded:    true,                 // mark as admin-seeded
      createdAt: Date.now(),
    }, { merge: true });
    console.log(`  ✓ ${s.name}`);
  }

  await batch.commit();
  console.log(`\n✅ Done! ${salons.length} salons added to the "salons" collection.`);
  console.log('   Open your app as a customer to see them all.\n');
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
});
