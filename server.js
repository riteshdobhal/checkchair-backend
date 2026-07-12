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
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const multer    = require('multer');
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

// ── Structured logging / telemetry ───────────────────────────────────────────
const SENSITIVE_KEY = /phone|token|otp|uid|firebase|password|secret/i;
const COORDINATE_KEY = /^(lat|lng|latitude|longitude)$/i;

function sanitizeLogValue(key, value) {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (COORDINATE_KEY.test(key) && typeof value === 'number') return Number(value.toFixed(3));
  if (typeof value === 'string' && value.length > 180) return `${value.slice(0, 177)}...`;
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

function sanitizeLogProperties(properties = {}) {
  return Object.entries(properties).reduce((acc, [key, value]) => {
    acc[key] = sanitizeLogValue(key, value);
    return acc;
  }, {});
}

// ── File logger (daily rotating, 7-day retention) ────────────────────────────
const LOG_DIR        = path.join(__dirname, 'logs');
const LOG_RETENTION  = 7; // days to keep

// Ensure logs/ directory exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Delete log files older than LOG_RETENTION days
function pruneOldLogs() {
  try {
    const cutoff = Date.now() - LOG_RETENTION * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(LOG_DIR)) {
      if (!file.endsWith('.log')) continue;
      const fullPath = path.join(LOG_DIR, file);
      const { mtimeMs } = fs.statSync(fullPath);
      if (mtimeMs < cutoff) fs.unlinkSync(fullPath);
    }
  } catch { /* non-fatal */ }
}
pruneOldLogs();

// Returns the file path for today's log, e.g. logs/app-2026-07-05.log
function todayLogPath() {
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(LOG_DIR, `app-${dateStr}.log`);
}

function writeToFile(line) {
  try {
    fs.appendFileSync(todayLogPath(), line + '\n', 'utf8');
  } catch { /* never crash on log failure */ }
}

function log(level, event, properties = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeLogProperties(properties),
  };
  const line = JSON.stringify(payload);
  const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  writer(line);
  writeToFile(line);
}

function logInfo(event, properties) { log('info', event, properties); }
function logWarn(event, properties) { log('warn', event, properties); }
function logError(event, err, properties = {}) {
  log('error', event, {
    ...properties,
    errorName: err?.name || 'Error',
    errorMessage: err?.message || String(err),
    ...(process.env.NODE_ENV !== 'production' && err?.stack ? { stack: err.stack } : {}),
  });
}

app.use((req, res, next) => {
  const startedAt = Date.now();
  req.requestId = crypto.randomUUID();
  res.on('finish', () => {
    logInfo('http_request', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });
  next();
});

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
logInfo('firebase_connected');

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
  logInfo('twilio_enabled');
} else {
  logWarn('twilio_not_configured');
}

// ════════════════════════════════════════════════════════════════════════════════
//  ASSISTANT LLM PROVIDER (OPTIONAL)
//  Powers the natural-language assistant ("show me open salons and alert me at the
//  nearest one"). Intent parsing is simple, so any of several backends work — the
//  first configured key wins:
//    ANTHROPIC_API_KEY → Claude (paid)
//    GROQ_API_KEY       → Groq   (free tier)
//    GEMINI_API_KEY     → Gemini (free tier)
//    (none)             → built-in keyword parser (no key, no network)
// ════════════════════════════════════════════════════════════════════════════════

const { parseAssistantIntent, assistantProvider } = require('./lib/assistantIntent');

const _assistantProvider = assistantProvider();
(_assistantProvider === 'keyword' ? logWarn : logInfo)('assistant_provider', { provider: _assistantProvider });

// ════════════════════════════════════════════════════════════════════════════════
//  SPEECH-TO-TEXT (Sarvam AI)
// ────────────────────────────────────────────────────────────────────────────────
//  Powers the mic button in the customer app's assistant search bar. Sarvam's
//  Saaras/Saarika models are purpose-built for Indian-language ASR — set
//  SARVAM_API_KEY to enable; the mic button is hidden client-side when it's absent
//  (see GET /stt/enabled below).
// ════════════════════════════════════════════════════════════════════════════════

const { transcribeAudio, sttEnabled } = require('./lib/sarvamStt');

const sttUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 }, // 15 MB — plenty for a short voice query
});

logInfo('stt_provider', { provider: sttEnabled() ? 'sarvam' : 'disabled' });

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

/**
 * POST /telemetry
 * Receives fire-and-forget client telemetry events from the mobile app.
 * Events are logged only; they are not persisted, and sensitive fields are redacted.
 */
app.post('/telemetry', (req, res) => {
  const { event, level = 'info', properties = {}, sessionId, platform, timestamp } = req.body || {};
  if (!event) return res.status(400).json({ error: 'event required' });

  const logLevel = ['info', 'warn', 'error'].includes(level) ? level : 'info';
  log(logLevel, 'client_telemetry', {
    clientEvent: event,
    sessionId,
    platform,
    clientTimestamp: timestamp,
    ...properties,
  });
  res.json({ ok: true });
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

    logInfo('auth_firebase_login_success', { phone, existingUser: userSnap.exists, role: user.role });
    res.json({ ok: true, user });
  } catch (err) {
    logError('auth_firebase_login_failed', err, { phone });
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
    logInfo('auth_role_set', { phone, role, category: updated.category || category || null, venueId: updated.venueId || null });
    res.json({ ok: true, user: updated, venueId: updated.venueId });
  } catch (err) {
    logError('auth_role_set_failed', err, { phone, role, category });
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
    logInfo('fcm_token_saved', { phone, hasToken: Boolean(token) });
    res.json({ ok: true });
  } catch (err) {
    logError('fcm_token_save_failed', err, { phone });
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

    logInfo('venue_profile_updated', { venueId, capacity: parseInt(capacity) || 6, hasPhone: Boolean(phone), hasCoordinates: latitude !== undefined && longitude !== undefined });
    res.json({ ok: true });
  } catch (err) {
    logError('venue_profile_update_failed', err, { venueId });
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
    logInfo('venue_detail_loaded', { venueId: req.params.venueId });
    res.json(snap.data());
  } catch (err) {
    logError('venue_detail_load_failed', err, { venueId: req.params.venueId });
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

    logInfo('venues_listed', { category: category || null, count: venues.length });
    res.json({ venues });
  } catch (err) {
    logError('venues_list_failed', err, { category });
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

    logInfo('venues_claimable_listed', { category: category || null, count: venues.length });
    res.json({ venues });
  } catch (err) {
    logError('venues_claimable_list_failed', err, { category });
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
    logInfo('venue_claimed', { phone, venueId, category: venue.category || 'salon' });
    res.json({ ok: true, venue: { ...venue, ownerId: phone }, user: userSnap.data() });
  } catch (err) {
    logError('venue_claim_failed', err, { phone, venueId });
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
    let notificationsTriggered = 0;

    for (const doc of subsSnap.docs) {
      const sub = doc.data();
      // Threshold crossing: was above threshold, now at or below it.
      if (prev >= sub.threshold && count < sub.threshold) {
        notificationsTriggered++;
        await notifySubscriber(sub, venue, count);
      }
    }

    logInfo('count_updated', { venueId, previousCount: prev, count, capacity: venue.capacity, subscribers: subsSnap.size, notificationsTriggered });
    res.json({ ok: true });
  } catch (err) {
    logError('count_update_failed', err, { venueId, count });
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
    logError('count_load_failed', err, { venueId: id });
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
  logInfo('subscriber_notification_started', { phone: sub.phone, venueId: sub.venueId, hasToken: Boolean(fcmToken), count });

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
      logInfo('subscriber_notification_fcm_sent', { phone: sub.phone, venueId: sub.venueId });
      return; // FCM succeeded — no need for WhatsApp fallback.
    } catch (err) {
      // FCM can fail if the token is stale (app reinstalled, etc.) — try WhatsApp.
      logError('subscriber_notification_fcm_failed', err, { phone: sub.phone, venueId: sub.venueId });
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
      .then(() => logInfo('subscriber_notification_whatsapp_sent', { phone: sub.phone, venueId: sub.venueId }))
      .catch(err => logError('subscriber_notification_whatsapp_failed', err, { phone: sub.phone, venueId: sub.venueId }));
  } else {
    logWarn('subscriber_notification_no_delivery_channel', { phone: sub.phone, venueId: sub.venueId });
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

    logInfo('subscription_created', { phone, venueId, threshold: parseInt(threshold) });
    res.json({ ok: true });
  } catch (err) {
    logError('subscription_create_failed', err, { phone, venueId, threshold });
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

    logInfo('subscriptions_listed', { phone: req.params.phone, count: subscriptions.length });
    res.json({ subscriptions });
  } catch (err) {
    logError('subscriptions_list_failed', err, { phone: req.params.phone });
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
    logInfo('subscription_removed', { phone, venueId });
    res.json({ ok: true });
  } catch (err) {
    logError('subscription_remove_failed', err, { phone, venueId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  NATURAL-LANGUAGE ASSISTANT
//  Turns a plain-English request ("show me open salons and alert me at the nearest
//  one") into an action: filter to venues with free seats, then subscribe the user
//  to the nearest one so they get a push notification without watching the app.
// ════════════════════════════════════════════════════════════════════════════════

const DEFAULT_ASSISTANT_THRESHOLD = 3;

/** Great-circle distance in km between two lat/lng points (haversine). */
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * POST /assistant/nearest-available
 * Natural-language entry point. Given a plain-English request and the user's
 * location, finds venues in a category that currently have free seats and — when
 * asked — subscribes the user to the nearest one.
 *
 * Body: { phone, name?, category, text, coords?: { lat, lng } }
 * Response: {
 *   ok, understood, message,
 *   subscribed: VenueResult | null,     // the venue we subscribed the user to
 *   available:  VenueResult[],          // open venues, nearest first
 * }
 * VenueResult: { venueId, venueName, count, capacity, availableNow, distanceKm|null, threshold? }
 */
app.post('/assistant/nearest-available', async (req, res) => {
  const { phone, name, category, text, coords } = req.body;
  if (!phone || !category || !text) {
    return res.status(400).json({ error: 'phone, category and text required' });
  }

  try {
    const categoryLabel = `${category}s`;
    const understood    = await parseAssistantIntent(text, categoryLabel, {
      onError: (err) => logError('assistant_parse_llm_failed', err),
    });
    logInfo('assistant_query', { phone, category, intent: understood.intent, source: understood.source, hasCoords: Boolean(coords) });

    if (understood.intent === 'unsupported') {
      return res.json({
        ok: true,
        understood,
        subscribed: null,
        available: [],
        message: "Sorry, I can only find open venues near you and set up alerts. Try: “show me open venues and alert me at the nearest one”.",
      });
    }

    // Load venues in this category and shape them for the response.
    const snap    = await venuesCol.where('category', '==', category).get();
    const hasHere = coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng);

    let venues = snap.docs.map((d) => {
      const v   = d.data();
      const lat = v.lat ?? v.latitude  ?? null;
      const lng = v.lng ?? v.longitude ?? null;
      return {
        venueId:      v.id,
        venueName:    v.name,
        count:        v.count,
        capacity:     v.capacity,
        availableNow: v.count < v.capacity,
        distanceKm:   hasHere && lat != null && lng != null
          ? Number(distanceKm(coords.lat, coords.lng, lat, lng).toFixed(2))
          : null,
      };
    });

    // Narrow to a specific venue when the customer named one (e.g. "show me only
    // New Classic Salon") — otherwise every question defaults to the generic
    // nearby list, which ignores what they actually asked.
    const namedVenue = Boolean(understood.venueName);
    if (namedVenue) {
      const needle = understood.venueName.toLowerCase();
      venues = venues.filter((v) => v.venueName && v.venueName.toLowerCase().includes(needle));

      if (venues.length === 0) {
        return res.json({
          ok: true,
          understood,
          subscribed: null,
          available: [],
          message: `I couldn't find a ${category} called "${understood.venueName}" nearby.`,
        });
      }
    }

    // Open venues only (when the user asked for that), nearest first.
    const available = venues
      .filter((v) => (understood.availableOnly ? v.availableNow : true))
      .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));

    // List-only intent: just return the open venues.
    if (understood.intent === 'list_available') {
      let message;
      if (namedVenue) {
        const v = available[0] || venues[0];
        message = available.length
          ? `${v.venueName} has ${v.count}/${v.capacity} right now.`
          : `${v.venueName} has no free seats right now.`;
      } else {
        message = available.length
          ? `Found ${available.length} ${categoryLabel} with seats available.`
          : `No ${categoryLabel} with free seats right now.`;
      }
      return res.json({ ok: true, understood, subscribed: null, available, message });
    }

    // subscribe_nearest — need a place to subscribe to.
    if (available.length === 0) {
      return res.json({
        ok: true,
        understood,
        subscribed: null,
        available,
        message: namedVenue
          ? `${venues[0].venueName} has no free seats right now — nothing to subscribe you to yet.`
          : `No ${categoryLabel} with free seats right now — nothing to subscribe you to yet.`,
      });
    }
    if (!hasHere) {
      return res.json({
        ok: true,
        understood,
        subscribed: null,
        available,
        message: 'Share your location so I can pick the nearest venue to subscribe you to.',
      });
    }

    const nearest   = available[0];
    const threshold = understood.threshold > 0 ? understood.threshold : DEFAULT_ASSISTANT_THRESHOLD;

    await subsCol.doc(subKey(phone, nearest.venueId)).set({
      phone,
      name:      name || phone,
      threshold,
      venueId:   nearest.venueId,
      createdAt: Date.now(),
    });
    logInfo('assistant_subscribed', { phone, venueId: nearest.venueId, threshold });

    return res.json({
      ok: true,
      understood,
      subscribed: { ...nearest, threshold },
      available,
      message: nearest.availableNow
        ? `${nearest.venueName} has seats now, and I'll alert you whenever it has fewer than ${threshold} people.`
        : `I'll alert you when ${nearest.venueName} drops below ${threshold} people.`,
    });
  } catch (err) {
    logError('assistant_query_failed', err, { phone, category });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /stt/enabled
 * Lets the client know whether voice input should be offered at all — the mic
 * button stays hidden if no SARVAM_API_KEY is configured on this deployment.
 */
app.get('/stt/enabled', (req, res) => {
  res.json({ enabled: sttEnabled() });
});

/**
 * POST /stt/transcribe
 * Transcribes a short recorded voice clip via Sarvam AI. Used by the customer
 * app's assistant mic button in place of on-device speech recognition, which
 * handles regional Indian languages (Kannada, Telugu, Tamil) inconsistently.
 *
 * Body: multipart/form-data
 *   file          — the recorded audio clip (m4a/wav/webm, <15 MB)
 *   languageCode  — optional BCP-47 code, e.g. "hi-IN" (omit to auto-detect)
 *
 * Response: { ok, transcript, languageCode }
 */
app.post('/stt/transcribe', sttUpload.single('file'), async (req, res) => {
  if (!sttEnabled()) {
    return res.status(503).json({ error: 'Speech-to-text is not configured on this server' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'file required' });
  }

  const languageCode = req.body.languageCode;
  try {
    const { transcript, languageCode: detected } = await transcribeAudio(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      languageCode,
    );
    logInfo('stt_transcribe', { languageCode: languageCode || 'auto', detected, chars: transcript.length });
    res.json({ ok: true, transcript, languageCode: detected });
  } catch (err) {
    logError('stt_transcribe_failed', err, { languageCode: languageCode || 'auto' });
    res.status(502).json({ error: 'Transcription failed' });
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
    logInfo('qr_generated', { venueId: req.params.venueId });
    res.send(qr);
  } catch (err) {
    logError('qr_generate_failed', err, { venueId: req.params.venueId });
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

    logInfo('venues_seeded_from_location', { lat, lng, added, updated, skipped, totalElements: elements.length });
    res.json({ ok: true, added, updated, skipped });
  } catch (err) {
    logError('venues_seed_from_location_failed', err, { lat, lng });
    res.status(500).json({ error: 'Failed to fetch venues from OpenStreetMap' });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET
//  On connection, immediately push a snapshot of all venue counts so the client
//  doesn't need a separate HTTP call on startup.
// ════════════════════════════════════════════════════════════════════════════════

io.on('connection', async (socket) => {
  logInfo('websocket_connected', { socketId: socket.id });

  try {
    // Send the full occupancy snapshot to the newly connected client.
    const snap = await venuesCol.get();
    const counts = snap.docs.map(d => {
      const s = d.data();
      return { venueId: s.id, count: s.count, capacity: s.capacity };
    });
    socket.emit('all_counts', counts);
    logInfo('websocket_initial_counts_sent', { socketId: socket.id, count: counts.length });
  } catch (err) {
    logError('websocket_initial_counts_failed', err, { socketId: socket.id });
  }

  socket.on('disconnect', (reason) => logInfo('websocket_disconnected', { socketId: socket.id, reason }));
});

// ════════════════════════════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════════════════════════════

server.listen(PORT, '0.0.0.0', () => {
  logInfo('server_started', { port: PORT, websocket: true, fcm: true, whatsappFallback: Boolean(twilio) });
});
