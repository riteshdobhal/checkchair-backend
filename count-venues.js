require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');

const sa = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./serviceAccountKey.json');
initializeApp({ credential: cert(sa) });

(async () => {
  const snap = await getFirestore().collection('venues').count().get();
  console.log(`Venues in Firestore: ${snap.data().count}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
