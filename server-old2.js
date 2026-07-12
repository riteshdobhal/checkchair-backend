const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const admin   = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { initializeApp, cert } = require('firebase-admin/app');
const QRCode  = require('qrcode');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Initialize Firebase Admin ──────────────────────────────────────────────────
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}


initializeApp({ credential: cert(serviceAccount) });
const db =  getFirestore();
console.log('✅ Firestore connected');

const { getMessaging } = require('firebase-admin/messaging');
const messaging = getMessaging();

// Collections
const usersCol = db.collection('users');
const salonsCol = db.collection('salons');
const subsCol  = db.collection('subscriptions');

// ── Optional Twilio (for WhatsApp alerts) ──────────────────────────────────────
let twilio = null;
const FROM = 'whatsapp:+14155238886';
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log('✅ Twilio loaded — WhatsApp enabled');
} else {
  console.log('⚠️  Twilio not configured — WhatsApp disabled');
}

// ── In-memory OTP store (OTPs are short-lived, no need to persist) ─────────────
const otpStore = new Map();
const genOTP   = () => Math.floor(100000 + Math.random() * 900000).toString();
const salonKey = (phone) => `salon_${phone.replace(/\D/g, '')}`;
const subKey   = (phone, salonId) => `${phone}_${salonId}`;

// ════════════════════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════════════════════

/*app.post('/auth/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const otp = genOTP();
  otpStore.set(phone, { otp, expiresAt: Date.now() + 5 * 60 * 1000 });
  console.log(`📱 OTP for ${phone}: ${otp}`);

  if (twilio) {
    await twilio.messages.create({
      from: FROM, to: `whatsapp:+91${phone}`,
      body: `Your ChairCheck OTP is ${otp}. Valid for 5 minutes.`,
    }).catch(console.error);
  }
  res.json({ ok: true });
});

app.post('/auth/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'phone and otp required' });

  const stored    = otpStore.get(phone);
  const isDev      = process.env.NODE_ENV !== 'production';
  const isTestOTP = isDev && otp === '123456';

  if (!isTestOTP) {
    if (!stored)                       return res.status(400).json({ ok: false, error: 'OTP not found' });
    if (Date.now() > stored.expiresAt) return res.status(400).json({ ok: false, error: 'OTP expired' });
    if (stored.otp !== otp)            return res.status(400).json({ ok: false, error: 'Invalid OTP' });
  }
  otpStore.delete(phone);

  // Get or create user in Firestore
  const userRef  = usersCol.doc(phone);
  const userSnap = await userRef.get();

  let user;
  if (userSnap.exists) {
    user = userSnap.data();
  } else {
    user = { id: phone, phone, name: '', role: null, salonId: null, createdAt: Date.now() };
    await userRef.set(user);
  }

  res.json({ ok: true, user });
}); */
app.post('/save-token', async (req, res) => {
  const { phone, token } = req.body;
  if (!phone || !token) return res.status(400).json({ error: 'phone and token required' });
  await usersCol.doc(phone).set({ fcmToken: token }, { merge: true });
  res.json({ ok: true });
});

app.post('/auth/set-role', async (req, res) => {
  const { phone, role, name } = req.body;
  if (!phone || !role || !name) return res.status(400).json({ error: 'phone, role and name required' });

  const userRef  = usersCol.doc(phone);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

  const updates = { name, role };

  if (role === 'owner') {
    const sid     = salonKey(phone);
    const salonRef = salonsCol.doc(sid);
    const salonSnap = await salonRef.get();
    if (!salonSnap.exists) {
      await salonRef.set({
        id: sid, name: `${name}'s Salon`, address: 'Address not set',
        hours: 'Hours not set', capacity: 6, count: 0, ownerId: phone, createdAt: Date.now(),
      });
    }
    updates.salonId = sid;
  }

  await userRef.update(updates);
  const updated = { ...userSnap.data(), ...updates };
  res.json({ ok: true, user: updated, salonId: updated.salonId });
});

// ════════════════════════════════════════════════════════════════════════════════
// SALONS
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

app.get('/salons', async (req, res) => {
  const snap = await salonsCol.get();
  const salons = snap.docs.map(d => {
    const s = d.data();
    return { id: s.id, name: s.name, address: s.address, hours: s.hours, count: s.count, capacity: s.capacity };
  });
  res.json({ salons });
});

// ════════════════════════════════════════════════════════════════════════════════
// COUNT
// ════════════════════════════════════════════════════════════════════════════════


app.post('/count', async (req, res) => {
  const { count, salonId } = req.body;
  console.log(`\n📊 COUNT UPDATE received: salonId=${salonId}, count=${count}`);

  if (salonId === undefined || count === undefined) {
    console.log('❌ Missing count or salonId');
    return res.status(400).json({ error: 'count and salonId required' });
  }

  const salonRef  = salonsCol.doc(salonId);
  const salonSnap = await salonRef.get();
  if (!salonSnap.exists) {
    console.log(`❌ Salon not found: ${salonId}`);
    return res.status(404).json({ error: 'Salon not found' });
  }

  const salon = salonSnap.data();
  const prev  = salon.count;
  console.log(`   Previous count: ${prev} → New count: ${count}`);

  await salonRef.update({ count });
  io.emit('count_update', { count, salonId, capacity: salon.capacity });

  // Check subscribers
  const subsSnap = await subsCol.where('salonId', '==', salonId).get();
  console.log(`   Subscribers for this salon: ${subsSnap.size}`);

  for (const doc of subsSnap.docs) {
    const sub = doc.data();
    console.log(`   → ${sub.phone}: threshold=${sub.threshold}, prev=${prev}, count=${count}`);

    if (prev >= sub.threshold && count < sub.threshold) {
      console.log(`   ✅ THRESHOLD CROSSED for ${sub.phone} — sending notification`);
      await notifySubscriber(sub, salon, count);
    } else {
      console.log(`   ⏭️  No crossing (need prev>=${sub.threshold} AND count<${sub.threshold})`);
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

// ════════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTIONS
// ════════════════════════════════════════════════════════════════════════════════

app.post('/subscribe', async (req, res) => {
  const { phone, name, threshold = 3, salonId } = req.body;
  if (!phone || !salonId) return res.status(400).json({ error: 'phone and salonId required' });

  const salonSnap = await salonsCol.doc(salonId).get();
  if (!salonSnap.exists) return res.status(404).json({ error: 'Salon not found' });
  const salon = salonSnap.data();

  await subsCol.doc(subKey(phone, salonId)).set({
    phone, name: name || phone, threshold: parseInt(threshold), salonId, createdAt: Date.now(),
  });

  if (twilio) {
    await twilio.messages.create({
      from: FROM, to: `whatsapp:+91${phone}`,
      body: `Hi ${name}! You are subscribed to ${salon.name}. You will get a message when fewer than ${threshold} customers are present. Reply STOP to unsubscribe. 💈`,
    }).catch(console.error);
  }
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

// ── QR code ─────────────────────────────────────────────────────────────────────
app.get('/qr/:salonId', async (req, res) => {
  const url = `${process.env.APP_URL || 'http://localhost:3000'}/salon/${req.params.salonId}`;
  const qr  = await QRCode.toBuffer(url, { width: 400, margin: 2 });
  res.set('Content-Type', 'image/png');
  res.send(qr);
});

app.post('/auth/firebase-login', async (req, res) => {
  const { phone, firebaseUid } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const userRef  = usersCol.doc(phone);
  const userSnap = await userRef.get();

  let user;
  if (userSnap.exists) {
    user = userSnap.data();
  } else {
    user = {
      id: phone, phone, firebaseUid: firebaseUid || '',
      name: '', role: null, salonId: null, createdAt: Date.now(),
    };
    await userRef.set(user);
  }

  res.json({ ok: true, user });
});

app.post('/whatsapp/webhook', async (req, res) => {
  const from = req.body.From;          // e.g. "whatsapp:+919876543210"
  const body = (req.body.Body || '').trim();
  const phone = from.replace('whatsapp:+91', '').replace('whatsapp:', '');

  console.log(`📩 WhatsApp from ${phone}: ${body}`);

  // Parse "SUBSCRIBE <salonId> <threshold> - ..."
  const match = body.match(/^SUBSCRIBE\s+(\S+)\s+(\d+)/i);

  // TwiML response — this reply is FREE because customer messaged first
  let reply = '';

  if (match) {
    const salonId   = match[1];
    const threshold = parseInt(match[2]);

    // Look up salon name
    const salonSnap = await salonsCol.doc(salonId).get();
    const salonName = salonSnap.exists ? salonSnap.data().name : salonId;

    // Save subscription
    await subsCol.doc(`${phone}_${salonId}`).set({
      phone, name: phone, threshold, salonId, createdAt: Date.now(),
    });

    reply = `✅ You're subscribed to ${salonName}! We'll message you here when there are fewer than ${threshold} customers. Reply STOP to unsubscribe.`;
  } else if (/^stop$/i.test(body)) {
    // Unsubscribe from all
    const snap = await subsCol.where('phone', '==', phone).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    reply = `You've been unsubscribed from all alerts. Message us again anytime to re-subscribe.`;
  } else {
    reply = `Hi! To get alerts, please subscribe through the CheckChair app. Reply STOP to unsubscribe.`;
  }

  // Send TwiML response (free-form reply within the 24h service window)
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
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



const PORT = process.env.PORT || 3000;
server.listen(PORT,'0.0.0.0', () => {
  console.log(`\n🚀 ChairCheck backend running on http://localhost:${PORT}`);
  console.log('   Data now persists in Firestore — survives restarts ✅');
  console.log('   DEV: use OTP "123456" to skip Twilio\n');
});
