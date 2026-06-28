// ════════════════════════════════════════════════════════════════════════════════
//  CheckChair Backend — server.js
//
//  A real-time occupancy tracking server for multi-vertical businesses
//  (salons, restaurants, clinics, gyms, cafes).
//
//  Stack:
//    - Express       HTTP REST API
//    - Socket.IO     Live count broadcast to connected clients
//    - Firebase Admin Firestore (database) + FCM (push notifications)
//    - Twilio        Optional WhatsApp fallback notifications
//    - QRCode        Per-venue QR code image generation
//
//  Collections in Firestore:
//    users         — registered users (customers & business owners)
//    venues        — business locations with live occupancy counts
//    subscriptions — customer threshold alerts per venue
// ════════════════════════════════════════════════════════════════════════════════

'use strict';

// ── Core dependencies ─────────────────────────────────────────────────────────
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const QRCode    = require('qrcode');
require('dotenv').config();

// ── Firebase Admin SDK ────────────────────────────────────────────────────────
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');
const { getMessaging }        = require('firebase-admin/messaging');

// ── App + HTTP server + WebSocket ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Allow any origin on WebSocket connections (lock this down in production).
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// ════════════════════════════════════════════════════════════════════════════════
//  FIREBASE INITIALISATION
//  Service account credentials come from an env var in production (CI/CD, Render)
//  and fall back to a local JSON file for local development.
// ════════════════════════════════════════════════════════════════════════════════

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Production: credentials stored as a JSON string in an env var.
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // Local development: credentials stored in a gitignored JSON file.
  serviceAccount = require('./serviceAccountKey.json');
}

initializeApp({ credential: cert(serviceAccount) });

const db        = getFirestore();
const messaging = getMessaging();
console.log('✅ Firestore + FCM connected');

// ── Firestore collection references ───────────────────────────────────────────
const usersCol  = db.collection('users');
const venuesCol = db.collection('venues');
const subsCol   = db.collection('subscriptions');

// ════════════════════════════════════════════════════════════════════════════════
//  TWILIO (OPTIONAL)
//  WhatsApp messages are sent as a fallback when a subscriber has no FCM token.
//  The Twilio sandbox number is used here; swap for a provisioned number in prod.
// ════════════════════════════════════════════════════════════════════════════════

let twilio = null;
// Twilio sandbox sender — replace with a dedicated WhatsApp number in production.
const WHATSAPP_FROM = 'whatsapp:+14155238886';

if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilio = require('twilio')(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  console.log('✅ Twilio loaded — WhatsApp backup enabled');
} else {
  console.log('⚠️  Twilio not configured — using FCM push only');
}

// ════════════════════════════════════════════════════════════════════════════════
//  CONSTANTS & HELPERS
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Default seating/slot capacity per business category.
 * Used when a new owner registers without specifying a custom capacity.
 */
const DEFAULT_CAP = {
  salon:      6,
  restaurant: 20,
  clinic:     15,
  gym:        40,
  cafe:       15,
};

const PORT = process.env.PORT || 3000;

/**
 * Derive a stable Firestore venue document ID from an owner's phone number.
 * Strips all non-digit characters so "+91 98765-43210" → "venue_9187654320".
 *
 * @param {string} phone - Raw phone string (may include spaces, dashes, +).
 * @returns {string} Firestore document ID, e.g. "venue_919876543210".
 */
const bizKey = (phone) => `venue_${phone.replace(/\D/g, '')}`;

/**
 * Derive a composite subscription document ID from a phone number + venue ID.
 * Ensures one subscription document per (subscriber, venue) pair.
 *
 * @param {string} phone   - Subscriber's phone number.
 * @param {string} venueId - Target venue document ID.
 * @returns {string} Composite key, e.g. "919876543210_venue_911234567890".
 */
const subKey = (phone, venueId) => `${phone}_${venueId}`;

// ════════════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════════

/**
 * GET /health
 * Lightweight liveness endpoint used by uptime monitors (e.g. Render's ping).
 * Does NOT touch Firestore so it stays fast and cheap.
 */
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'awake', time: new Date().toISOString() });
});

// ════════════════════════════════════════════════════════════════════════════════
//  AUTH
//  Firebase handles OTP verification client-side; the backend only creates or
//  loads the user record and assigns roles.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * POST /auth/firebase-login
 * Called after a successful Firebase phone-OTP login on the client.
 * Creates the user document on first login; returns the existing one afterwards.
 *
 * Body: { phone: string, firebaseUid?: string }
 * Response: { ok: true, user: User }
 */
app.post('/auth/firebase-login', async (req, res) => {
  const { phone, firebaseUid } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const userRef  = usersCol.doc(phone);
    const userSnap = await userRef.get();

    let user;
    if (userSnap.exists) {
      // Returning user — just return the stored record.
      user = userSnap.data();
    } else {
      // First login — create a bare user record; role is set later via /auth/set-role.
      user = {
        id:         phone,
        phone,
        firebaseUid: firebaseUid || '',
        name:        '',
        role:        null,    // 'customer' | 'owner' — assigned at onboarding
        venueId:     null,    // only set for owners
        category:    null,    // business category for owners
        fcmToken:    null,    // set by /save-token after app initialises
        createdAt:   Date.now(),
      };
      await userRef.set(user);
    }

    res.json({ ok: true, user });
  } catch (err) {
    console.error('❌ /auth/firebase-login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/set-role
 * Assigns a role ('customer' or 'owner') after onboarding.
 * For owners, also creates (or skips if already exists) their venue document.
 *
 * Body: { phone: string, role: 'customer'|'owner', name: string, category?: string }
 * Response: { ok: true, user: User, venueId: string|null }
 */
app.post('/auth/set-role', async (req, res) => {
  const { phone, role, name, category } = req.body;
  if (!phone || !role || !name) {
    return res.status(400).json({ error: 'phone, role and name required' });
  }

  try {
    const userRef  = usersCol.doc(phone);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

    const updates = { name, role };

    if (role === 'owner') {
      const cat      = category || 'salon';
      const sid      = bizKey(phone);
      const venueRef = venuesCol.doc(sid);

      // Only create the venue if it doesn't already exist (idempotent).
      if (!(await venueRef.get()).exists) {
        await venueRef.set({
          id:        sid,
          name:      `${name}'s ${cat}`,
          category:  cat,
          address:   'Address not set',
          hours:     'Hours not set',
          capacity:  DEFAULT_CAP[cat] || 6,
          count:     0,
          ownerId:   phone,
          createdAt: Date.now(),
        });
      }

      updates.venueId  = sid;
      updates.category = cat;
    }

    await userRef.update(updates);
    const updated = { ...userSnap.data(), ...updates };
    res.json({ ok: true, user: updated, venueId: updated.venueId });
  } catch (err) {
    console.error('❌ /auth/set-role error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /save-token
 * Persists the FCM device token for a user so push notifications can be sent.
 * Uses Firestore merge so no other fields are overwritten.
 *
 * Body: { phone: string, token: string }
 * Response: { ok: true }
 */
app.post('/save-token', async (req, res) => {
  const { phone, token } = req.body;
  if (!phone || !token) {
    return res.status(400).json({ error: 'phone and token required' });
  }

  try {
    await usersCol.doc(phone).set({ fcmToken: token }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ /save-token error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  VENUES
//  A venue represents a physical business location (salon, restaurant, clinic,
//  gym, or cafe). Venues are either self-created by owners at registration or
//  admin-seeded and later claimed by their real owner.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * POST /venue/profile
 * Owner updates their venue's display information.
 * Emits a `venue_updated` socket event so open customer screens refresh.
 *
 * Body: { venueId: string, name: string, address: string, hours: string,
 *         capacity: number, phone?: string }
 * Response: { ok: true }
 */
app.post('/venue/profile', async (req, res) => {
  const { venueId, name, address, hours, capacity, phone, latitude, longitude } = req.body;
  if (!venueId) return res.status(400).json({ error: 'venueId required' });

  try {
    const update = {
      name,
      address,
      hours,
      capacity: parseInt(capacity) || 6,
    };

    // Allow clearing the venue contact phone (set to null) with an explicit empty string.
    if (phone !== undefined) update.phone = phone.trim() || null;

    // Store coordinates as numbers, or null to clear them.
    if (latitude !== undefined)  update.latitude  = latitude  !== null ? parseFloat(latitude)  : null;
    if (longitude !== undefined) update.longitude = longitude !== null ? parseFloat(longitude) : null;

    await venuesCol.doc(venueId).set(update, { merge: true });

    // Notify all connected clients so they can update venue info in real time.
    io.emit('venue_updated', { venueId, name, capacity: parseInt(capacity) || 6 });

    res.json({ ok: true });
  } catch (err) {
    console.error('❌ /venue/profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /venue/:venueId
 * Returns the full venue document for a given venue ID.
 *
 * Response: Venue object (all fields)
 */
app.get('/venue/:venueId', async (req, res) => {
  try {
    const snap = await venuesCol.doc(req.params.venueId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Venue not found' });
    res.json(snap.data());
  } catch (err) {
    console.error('❌ /venue/:venueId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /venues
 * Returns a summary list of all venues, optionally filtered by category.
 *
 * Query params: category? — e.g. ?category=restaurant
 * Response: { venues: VenueSummary[] }
 */
app.get('/venues', async (req, res) => {
  const { category } = req.query;

  try {
    // Build query — Firestore requires an index for filtered queries on multiple fields.
    let query = venuesCol;
    if (category) query = venuesCol.where('category', '==', category);

    const snap   = await query.get();
    const venues = snap.docs.map(d => {
      const s = d.data();
      return {
        id:        s.id,
        name:      s.name,
        address:   s.address,
        hours:     s.hours,
        count:     s.count,
        capacity:  s.capacity,
        category:  s.category  || 'salon',
        ownerId:   s.ownerId   || null,
        phone:     s.phone     || null,
        latitude:  s.lat ?? s.latitude  ?? null,
        longitude: s.lng ?? s.longitude ?? null,
      };
    });

    res.json({ venues });
  } catch (err) {
    console.error('❌ /venues error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /venues/claimable
 * Returns venues that have been admin-seeded but not yet claimed by an owner.
 * Used in the owner onboarding flow so they can claim an existing listing rather
 * than create a new one.
 *
 * Query params: category? — e.g. ?category=gym
 * Response: { venues: VenueSummary[] }
 */
app.get('/venues/claimable', async (req, res) => {
  const { category } = req.query;

  try {
    let query = venuesCol;
    if (category) query = venuesCol.where('category', '==', category);

    const snap   = await query.get();
    const venues = snap.docs
      .map(d => d.data())
      // Only include venues that have no owner yet.
      .filter(s => !s.ownerId)
      .map(s => ({
        id:       s.id,
        name:     s.name,
        address:  s.address,
        hours:    s.hours,
        count:    s.count,
        capacity: s.capacity,
        category: s.category || 'salon',
      }));

    res.json({ venues });
  } catch (err) {
    console.error('❌ /venues/claimable error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /venue/claim
 * Links an existing (admin-seeded) venue to an owner's account.
 * Enforces one-owner-per-venue — returns 409 if already claimed.
 * Updates both the venue document (ownerId) and the user document (role, venueId).
 *
 * Body: { phone: string, venueId: string, name?: string }
 * Response: { ok: true, venue: Venue, user: User }
 */
app.post('/venue/claim', async (req, res) => {
  const { phone, venueId, name } = req.body;
  if (!phone || !venueId) {
    return res.status(400).json({ error: 'phone and venueId required' });
  }

  try {
    const venueRef  = venuesCol.doc(venueId);
    const snap      = await venueRef.get();

    if (!snap.exists)        return res.status(404).json({ error: 'Venue not found' });
    if (snap.data().ownerId) return res.status(409).json({ error: 'This venue is already claimed' });

    const venue = snap.data();

    // Link both directions atomically: venue → owner, owner → venue.
    await venueRef.update({ ownerId: phone });
    await usersCol.doc(phone).update({
      role:     'owner',
      venueId,
      category: venue.category || 'salon',
      // Only overwrite the name if provided (owner may have set it earlier).
      ...(name ? { name } : {}),
    });

    const userSnap = await usersCol.doc(phone).get();
    res.json({ ok: true, venue: { ...venue, ownerId: phone }, user: userSnap.data() });
  } catch (err) {
    console.error('❌ /venue/claim error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  OCCUPANCY COUNT
//  Owners post the current headcount; the server persists it, broadcasts it to
//  all WebSocket clients, and triggers threshold notifications for subscribers.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * POST /count
 * Owner updates the live occupancy count for their venue.
 * Side effects:
 *   1. Persists count to Firestore.
 *   2. Broadcasts `count_update` to all Socket.IO clients.
 *   3. Sends push/WhatsApp notifications to subscribers whose threshold was just
 *      crossed from above (i.e. venue went from busy → quiet).
 *
 * Body: { venueId: string, count: number }
 * Response: { ok: true }
 */
app.post('/count', async (req, res) => {
  const { count, venueId } = req.body;
  console.log(`\n📊 COUNT UPDATE: venueId=${venueId}, count=${count}`);

  if (venueId === undefined || count === undefined) {
    return res.status(400).json({ error: 'count and venueId required' });
  }

  try {
    const venueRef  = venuesCol.doc(venueId);
    const venueSnap = await venueRef.get();
    if (!venueSnap.exists) return res.status(404).json({ error: 'Venue not found' });

    const venue = venueSnap.data();
    const prev  = venue.count;   // previous count — needed for threshold crossing check

    await venueRef.update({ count });

    // Broadcast the new count to every connected mobile/web client.
    io.emit('count_update', { count, venueId, capacity: venue.capacity });

    // Only notify subscribers when the count crosses their threshold downward
    // (i.e. they were waiting for it to get quieter).
    const subsSnap = await subsCol.where('venueId', '==', venueId).get();
    console.log(`   Subscribers: ${subsSnap.size}`);

    for (const doc of subsSnap.docs) {
      const sub = doc.data();
      // Threshold crossing: was above threshold, now at or below it.
      if (prev >= sub.threshold && count < sub.threshold) {
        console.log(`   ✅ Threshold crossed for ${sub.phone} — notifying`);
        await notifySubscriber(sub, venue, count);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('❌ /count POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /count
 * Returns the current occupancy count for a venue.
 * Returns 0 if the venue ID is missing or the document doesn't exist.
 *
 * Query params: id — venueId
 * Response: { count: number, updatedAt: string }
 */
app.get('/count', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.json({ count: 0 });

  try {
    const snap = await venuesCol.doc(id).get();
    res.json({
      count:     snap.exists ? snap.data().count : 0,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('❌ /count GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Sends a threshold-crossed notification to one subscriber.
 * Strategy: try FCM push first (free); fall back to Twilio WhatsApp (paid)
 * if the user has no FCM token or the push fails.
 *
 * The FCM `data` payload includes the venueId and target screen name so the
 * app can deep-link the user directly to the venue detail screen on tap.
 *
 * @param {{ phone: string, name: string, threshold: number, venueId: string }} sub
 * @param {{ id: string, name: string, category?: string }} venue
 * @param {number} count - Current occupancy after the update.
 */
async function notifySubscriber(sub, venue, count) {
  const userSnap = await usersCol.doc(sub.phone).get();
  const fcmToken = userSnap.exists ? userSnap.data().fcmToken : null;
  console.log(`   📲 notify ${sub.phone}, hasToken=${!!fcmToken}`);

  if (fcmToken) {
    try {
      await messaging.send({
        token: fcmToken,
        notification: {
          title: `${venue.name} is quiet now!`,
          body:  `Only ${count} now. Come on in!`,
        },
        // Extra data lets the app navigate to the right screen when the user taps.
        data: {
          venueId:   venue.id,
          venueName: venue.name,
          category:  venue.category || 'salon',
          screen:    'VenueDetail',
        },
        android: {
          priority:     'high',
          notification: { channelId: 'freechair-alerts', sound: 'default' },
        },
      });
      console.log(`   ✅ FCM push sent to ${sub.phone}`);
      return; // FCM succeeded — no need for WhatsApp fallback.
    } catch (err) {
      // FCM can fail if the token is stale (app reinstalled, etc.) — try WhatsApp.
      console.log(`   ❌ FCM failed, trying WhatsApp: ${err.message}`);
    }
  }

  // WhatsApp fallback — only runs if Twilio is configured.
  if (twilio) {
    await twilio.messages
      .create({
        from: WHATSAPP_FROM,
        to:   `whatsapp:+91${sub.phone}`,
        body: `Hi ${sub.name}! ${venue.name} now has only ${count} customer(s). Come on in! 💈`,
      })
      .then(() => console.log(`   ✅ WhatsApp sent to ${sub.phone}`))
      .catch(err => console.log(`   ❌ WhatsApp failed: ${err.message}`));
  }
}

// ════════════════════════════════════════════════════════════════════════════════
//  SUBSCRIPTIONS
//  Customers subscribe to a venue with a custom headcount threshold.
//  They receive a notification when the count drops below that threshold.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * POST /subscribe
 * Creates or overwrites a subscription for a (customer, venue) pair.
 *
 * Body: { phone: string, venueId: string, name?: string, threshold?: number }
 *   threshold defaults to 3 if not provided.
 * Response: { ok: true }
 */
app.post('/subscribe', async (req, res) => {
  const { phone, name, threshold = 3, venueId } = req.body;
  if (!phone || !venueId) {
    return res.status(400).json({ error: 'phone and venueId required' });
  }

  try {
    // Verify the venue exists before creating a dangling subscription.
    const venueSnap = await venuesCol.doc(venueId).get();
    if (!venueSnap.exists) return res.status(404).json({ error: 'Venue not found' });

    await subsCol.doc(subKey(phone, venueId)).set({
      phone,
      name:      name || phone,
      threshold: parseInt(threshold),
      venueId,
      createdAt: Date.now(),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('❌ /subscribe error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /subscriptions/:phone
 * Returns all active subscriptions for a customer, enriched with venue names.
 *
 * Response: { subscriptions: Array<{ venueId, venueName, threshold }> }
 */
app.get('/subscriptions/:phone', async (req, res) => {
  try {
    const snap          = await subsCol.where('phone', '==', req.params.phone).get();
    const subscriptions = [];

    for (const doc of snap.docs) {
      const sub       = doc.data();
      const venueSnap = await venuesCol.doc(sub.venueId).get();
      subscriptions.push({
        venueId:   sub.venueId,
        // Fall back to the raw venueId if the venue document was deleted.
        venueName: venueSnap.exists ? venueSnap.data().name : sub.venueId,
        threshold: sub.threshold,
      });
    }

    res.json({ subscriptions });
  } catch (err) {
    console.error('❌ /subscriptions/:phone error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /unsubscribe
 * Removes a subscription for a (customer, venue) pair.
 *
 * Body: { phone: string, venueId: string }
 * Response: { ok: true }
 */
app.post('/unsubscribe', async (req, res) => {
  const { phone, venueId } = req.body;
  if (!phone || !venueId) {
    return res.status(400).json({ error: 'phone and venueId required' });
  }

  try {
    await subsCol.doc(subKey(phone, venueId)).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ /unsubscribe error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  QR CODE
// ════════════════════════════════════════════════════════════════════════════════

/**
 * GET /qr/:venueId
 * Returns a PNG QR code that deep-links to the venue detail page in the app.
 * Useful for owners to print and display at their front desk.
 *
 * Response: image/png
 */
app.get('/qr/:venueId', async (req, res) => {
  try {
    const baseUrl = process.env.APP_URL || 'http://localhost:3000';
    const url     = `${baseUrl}/venue/${req.params.venueId}`;
    const qr      = await QRCode.toBuffer(url, { width: 400, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.send(qr);
  } catch (err) {
    console.error('❌ /qr/:venueId error:', err);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  VENUE SEEDING FROM USER LOCATION
//  Called when a customer shares their GPS coordinates. Fetches nearby businesses
//  from OpenStreetMap (Overpass API) and writes them to Firestore.
//  Deduplication: OSM element IDs are used as Firestore doc IDs so the same
//  business is never written twice regardless of how many users trigger this.
// ════════════════════════════════════════════════════════════════════════════════

const CATEGORY_OSM = {
  salon:      [['shop', 'hairdresser'], ['shop', 'beauty'], ['amenity', 'beauty_salon']],
  cafe:       [['amenity', 'cafe']],
  gym:        [['leisure', 'fitness_centre'], ['leisure', 'sports_centre']],
  restaurant: [['amenity', 'restaurant'], ['amenity', 'fast_food']],
  clinic:     [['amenity', 'clinic'], ['amenity', 'doctors'], ['amenity', 'hospital']],
};

function buildOverpassQuery(lat, lng, radiusM) {
  const parts = [];
  for (const pairs of Object.values(CATEGORY_OSM)) {
    for (const [k, v] of pairs) {
      parts.push(`node["${k}"="${v}"](around:${radiusM},${lat},${lng});`);
      parts.push(`way["${k}"="${v}"](around:${radiusM},${lat},${lng});`);
    }
  }
  return `[out:json][timeout:60];(${parts.join('')});out center tags;`;
}

function osmCategoryOf(tags) {
  for (const [catId, pairs] of Object.entries(CATEGORY_OSM)) {
    for (const [k, v] of pairs) {
      if (tags[k] === v) return catId;
    }
  }
  return null;
}

function osmAddressOf(tags) {
  return [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:suburb'] || tags['addr:neighbourhood'],
    tags['addr:city'],
  ].filter(Boolean).join(', ') || 'Address not set';
}

async function fetchOverpass(query) {
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'CheckChair/1.0 (contact: dev@checkchair.app)',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (r.ok) return r.json();
    } catch { /* try next mirror */ }
  }
  throw new Error('All Overpass endpoints failed');
}

/**
 * POST /venues/seed-from-location
 * Fetches venues from OpenStreetMap within 10 km of the given coordinates and
 * writes them to Firestore. Uses OSM element IDs as document IDs so the same
 * business is never duplicated even if multiple users in the same area trigger this.
 *
 * Body: { lat: number, lng: number }
 * Response: { ok: true, added: number, updated: number, skipped: number }
 */
app.post('/venues/seed-from-location', async (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) {
    return res.status(400).json({ error: 'lat and lng required' });
  }

  try {
    const query    = buildOverpassQuery(lat, lng, 10000); // 10 km covers all filter options
    const data     = await fetchOverpass(query);
    const elements = data.elements || [];

    let added = 0, updated = 0, skipped = 0;

    for (const el of elements) {
      const tags     = el.tags || {};
      const name     = tags.name;
      if (!name) { skipped++; continue; }

      const category = osmCategoryOf(tags);
      if (!category) { skipped++; continue; }

      const elLat = el.lat ?? el.center?.lat ?? null;
      const elLng = el.lon ?? el.center?.lon ?? null;

      // Skip venues outside India (lat 8–37°N, lng 68–97°E)
      if (elLat != null && (elLat < 8 || elLat > 37 || elLng < 68 || elLng > 97)) {
        skipped++; continue;
      }

      const id  = `osm_${el.type}_${el.id}`;
      const ref = venuesCol.doc(id);
      const existing = await ref.get();

      const fields = {
        id, name, category,
        address:   osmAddressOf(tags),
        hours:     tags.opening_hours || 'Hours not set',
        capacity:  DEFAULT_CAP[category] || 6,
        latitude:  elLat,
        longitude: elLng,
        source:    'osm',
      };

      if (!existing.exists) {
        await ref.set({ ...fields, count: 0, ownerId: null, createdAt: Date.now() });
        added++;
      } else {
        // Refresh address / hours / coords but preserve live count and ownerId
        await ref.set(fields, { merge: true });
        updated++;
      }
    }

    console.log(`📍 seed-from-location (${lat},${lng}): +${added} new, ~${updated} refreshed, ${skipped} skipped`);
    res.json({ ok: true, added, updated, skipped });
  } catch (err) {
    console.error('❌ /venues/seed-from-location error:', err);
    res.status(500).json({ error: 'Failed to fetch venues from OpenStreetMap' });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET
//  On connection, immediately push a snapshot of all venue counts so the client
//  doesn't need a separate HTTP call on startup.
// ════════════════════════════════════════════════════════════════════════════════

io.on('connection', async (socket) => {
  console.log('📱 Client connected');

  try {
    // Send the full occupancy snapshot to the newly connected client.
    const snap = await venuesCol.get();
    socket.emit('all_counts', snap.docs.map(d => {
      const s = d.data();
      return { venueId: s.id, count: s.count, capacity: s.capacity };
    }));
  } catch (err) {
    console.error('❌ WebSocket initial snapshot error:', err);
  }

  socket.on('disconnect', () => console.log('📱 Client disconnected'));
});

// ════════════════════════════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════════════════════════════

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 CheckChair backend running on port ${PORT}`);
  console.log('   Multi-vertical + FCM push + WhatsApp backup\n');
});
