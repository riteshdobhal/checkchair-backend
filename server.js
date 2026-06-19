// ════════════════════════════════════════════════════════════════════════════════
//  FreeChair backend — complete server.js
//  Firestore + Firebase OTP login + FCM push + multi-vertical categories
//  + optional Twilio WhatsApp + notification deep-link payload
// ════════════════════════════════════════════════════════════════════════════════

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const QRCode  = require('qrcode');
require('dotenv').config();

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');
const { getMessaging }        = require('firebase-admin/messaging');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
app.use(express.json());

// ── Firebase Admin init ─────────────────────────────────────────────────────────
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}
initializeApp({ credential: cert(serviceAccount) });
const db        = getFirestore();
const messaging = getMessaging();
console.log('✅ Firestore + FCM connected');

const usersCol = db.collection('users');
const salonsCol = db.collection('salons');
const subsCol  = db.collection('subscriptions');

// ── Optional Twilio (WhatsApp backup) ───────────────────────────────────────────
let twilio = null;
const WHATSAPP_FROM = 'whatsapp:+14155238886';
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log('✅ Twilio loaded — WhatsApp backup enabled');
} else {
  console.log('⚠️  Twilio not configured — using FCM push only');
}

// ── Helpers ──────────────────────────────────────────────────────────────────────
const bizKey = (phone) => `salon_${phone.replace(/\D/g, '')}`;
const subKey = (phone, salonId) => `${phone}_${salonId}`;

// Default capacity per category (used when a new business is created)
const DEFAULT_CAP = { salon: 6, restaurant: 20, clinic: 15, gym: 40, cafe: 15 };

// ── Health check (for uptime ping — does NOT touch Firestore) ───────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'awake', time: new Date().toISOString() });
});

// ════════════════════════════════════════════════════════════════════════════════
//  AUTH  (Firebase verifies OTP in the app; backend creates/loads the user)
// ════════════════════════════════════════════════════════════════════════════════

app.post('/auth/firebase-login', async (req, res) => {
  const { phone, firebaseUid } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const userRef  = usersCol.doc(phone);
  const userSnap = await userRef.get();

  let user;
  if (userSnap.exists) {
    user = userSnap.data();
  } else {
    user = { id: phone, phone, firebaseUid: firebaseUid || '', name: '', role: null, salonId: null, category: null, fcmToken: null, createdAt: Date.now() };
    await userRef.set(user);
  }
  res.json({ ok: true, user });
});

app.post('/auth/set-role', async (req, res) => {
  const { phone, role, name, category } = req.body;
  if (!phone || !role || !name) return res.status(400).json({ error: 'phone, role and name required' });

  const userRef  = usersCol.doc(phone);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

  const updates = { name, role };

  if (role === 'owner') {
    const cat      = category || 'salon';
    const sid      = bizKey(phone);
    const salonRef = salonsCol.doc(sid);
    if (!(await salonRef.get()).exists) {
      await salonRef.set({
        id: sid,
        name: `${name}'s ${cat}`,
        category: cat,
        address: 'Address not set',
        hours: 'Hours not set',
        capacity: DEFAULT_CAP[cat] || 6,
        count: 0,
        ownerId: phone,
        createdAt: Date.now(),
      });
    }
    updates.salonId  = sid;
    updates.category = cat;
  }

  await userRef.update(updates);
  const updated = { ...userSnap.data(), ...updates };
  res.json({ ok: true, user: updated, salonId: updated.salonId });
});

// ── Save FCM device token ────────────────────────────────────────────────────────
app.post('/save-token', async (req, res) => {
  const { phone, token } = req.body;
  if (!phone || !token) return res.status(400).json({ error: 'phone and token required' });
  await usersCol.doc(phone).set({ fcmToken: token }, { merge: true });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
//  BUSINESSES (salons / restaurants / clinics / gyms / cafes)
// ════════════════════════════════════════════════════════════════════════════════

app.post('/salon/profile', async (req, res) => {
  const { salonId, name, address, hours, capacity } = req.body;
  if (!salonId) return res.status(400).json({ error: 'salonId required' });
  await salonsCol.doc(salonId).set(
    { name, address, hours, capacity: parseInt(capacity) || 6 },
    { merge: true }
  );
  io.emit('salon_updated', { salonId, name, capacity: parseInt(capacity) || 6 });
  res.json({ ok: true });
});

app.get('/salon/:salonId', async (req, res) => {
  const snap = await salonsCol.doc(req.params.salonId).get();
  if (!snap.exists) return res.status(404).json({ error: 'Salon not found' });
  res.json(snap.data());
});

// List — optionally filtered by category (?category=restaurant)
app.get('/salons', async (req, res) => {
  const { category } = req.query;
  let query = salonsCol;
  if (category) query = salonsCol.where('category', '==', category);

  const snap = await query.get();
  const salons = snap.docs.map(d => {
    const s = d.data();
    return {
      id: s.id, name: s.name, address: s.address, hours: s.hours,
      count: s.count, capacity: s.capacity, category: s.category || 'salon',
    };
  });
  res.json({ salons });
});

// ════════════════════════════════════════════════════════════════════════════════
//  COUNT  (owner updates → broadcast live + notify subscribers)
// ════════════════════════════════════════════════════════════════════════════════

app.post('/count', async (req, res) => {
  const { count, salonId } = req.body;
  console.log(`\n📊 COUNT UPDATE: salonId=${salonId}, count=${count}`);
  if (salonId === undefined || count === undefined) return res.status(400).json({ error: 'count and salonId required' });

  const salonRef  = salonsCol.doc(salonId);
  const salonSnap = await salonRef.get();
  if (!salonSnap.exists) return res.status(404).json({ error: 'Salon not found' });

  const salon = salonSnap.data();
  const prev  = salon.count;
  await salonRef.update({ count });
  io.emit('count_update', { count, salonId, capacity: salon.capacity });

  // Notify subscribers who just crossed their threshold (busy → quiet)
  const subsSnap = await subsCol.where('salonId', '==', salonId).get();
  console.log(`   Subscribers: ${subsSnap.size}`);
  for (const doc of subsSnap.docs) {
    const sub = doc.data();
    if (prev >= sub.threshold && count < sub.threshold) {
      console.log(`   ✅ Threshold crossed for ${sub.phone} — notifying`);
      await notifySubscriber(sub, salon, count);
    }
  }
  res.json({ ok: true });
});

app.get('/count', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.json({ count: 0 });
  const snap = await salonsCol.doc(id).get();
  res.json({ count: snap.exists ? snap.data().count : 0, updatedAt: new Date().toISOString() });
});

// ── Notify one subscriber: FCM push first (free), WhatsApp backup (paid) ─────────
async function notifySubscriber(sub, salon, count) {
  const userSnap = await usersCol.doc(sub.phone).get();
  const fcmToken = userSnap.exists ? userSnap.data().fcmToken : null;
  console.log(`   📲 notify ${sub.phone}, hasToken=${!!fcmToken}`);

  if (fcmToken) {
    try {
      await messaging.send({
        token: fcmToken,
        notification: {
          title: `${salon.name} is quiet now!`,
          body:  `Only ${count} now. Come on in!`,
        },
        data: {
          salonId:   salon.id,
          salonName: salon.name,
          screen:    'SalonDetail',
        },
        android: { priority: 'high', notification: { channelId: 'freechair-alerts', sound: 'default' } },
      });
      console.log(`   ✅ FCM push sent to ${sub.phone}`);
      return;
    } catch (err) {
      console.log(`   ❌ FCM failed, trying WhatsApp: ${err.message}`);
    }
  }

  if (twilio) {
    await twilio.messages.create({
      from: WHATSAPP_FROM, to: `whatsapp:+91${sub.phone}`,
      body: `Hi ${sub.name}! ${salon.name} now has only ${count} customer(s). Come on in! 💈`,
    }).then(() => console.log(`   ✅ WhatsApp sent to ${sub.phone}`))
      .catch(err => console.log(`   ❌ WhatsApp failed: ${err.message}`));
  }
}

// ════════════════════════════════════════════════════════════════════════════════
//  SUBSCRIPTIONS
// ════════════════════════════════════════════════════════════════════════════════

app.post('/subscribe', async (req, res) => {
  const { phone, name, threshold = 3, salonId } = req.body;
  if (!phone || !salonId) return res.status(400).json({ error: 'phone and salonId required' });

  const salonSnap = await salonsCol.doc(salonId).get();
  if (!salonSnap.exists) return res.status(404).json({ error: 'Salon not found' });

  await subsCol.doc(subKey(phone, salonId)).set({
    phone, name: name || phone, threshold: parseInt(threshold), salonId, createdAt: Date.now(),
  });
  res.json({ ok: true });
});

app.get('/subscriptions/:phone', async (req, res) => {
  const snap = await subsCol.where('phone', '==', req.params.phone).get();
  const subscriptions = [];
  for (const doc of snap.docs) {
    const sub      = doc.data();
    const salonSnap = await salonsCol.doc(sub.salonId).get();
    subscriptions.push({
      salonId:   sub.salonId,
      salonName: salonSnap.exists ? salonSnap.data().name : sub.salonId,
      threshold: sub.threshold,
    });
  }
  res.json({ subscriptions });
});

app.post('/unsubscribe', async (req, res) => {
  const { phone, salonId } = req.body;
  await subsCol.doc(subKey(phone, salonId)).delete();
  res.json({ ok: true });
});

// ── QR code ───────────────────────────────────────────────────────────────────
app.get('/qr/:salonId', async (req, res) => {
  const url = `${process.env.APP_URL || 'http://localhost:3000'}/salon/${req.params.salonId}`;
  const qr  = await QRCode.toBuffer(url, { width: 400, margin: 2 });
  res.set('Content-Type', 'image/png');
  res.send(qr);
});

// ── WebSocket ──────────────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
  console.log('📱 Client connected');
  const snap = await salonsCol.get();
  socket.emit('all_counts', snap.docs.map(d => {
    const s = d.data();
    return { salonId: s.id, count: s.count, capacity: s.capacity };
  }));
  socket.on('disconnect', () => console.log('📱 Client disconnected'));
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 FreeChair backend running on port ${PORT}`);
  console.log('   Multi-vertical + FCM push + WhatsApp backup\n');
});
