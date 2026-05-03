// src/services/fraudDetector.js
// ============================================================
// Anti-fraud Layer 2: passive abuse detection
//
// Per Avi's PR 2 discipline (2026-05-03):
//   "Keep it passive (write-only to fraud_signals) for v1 - no
//    enforcement actions yet. Enforcement comes after we see what
//    real signals look like."
//
// API:
//   logSignal(userId, signalType, details)       - direct write
//   checkRapidBurst(userId, opts)                - read-only detector
//   checkMultiAccountByDevice(userId)            - read-only detector
//   checkGeofenceViolation(userId, lat, lng, store) - read-only detector
//   analyzeAndLog(userId, context)               - runs all detectors + logs triggered
//
// Call sites (added in later PRs):
//   - products.js /batch-price        (point velocity, rapid burst)
//   - storeLayouts.js scan/confirm    (geofence violation, rapid burst)
//   - auth registration/login         (multi-account by device)
// ============================================================

const { query } = require('../models/db');

// ── Tunable thresholds (v1 starting values, all configurable later) ──
const DEFAULTS = {
  // Rapid burst: > N actions within W seconds is suspicious
  rapidBurstThreshold: 10,
  rapidBurstWindowSeconds: 60,

  // Multi-account: > N users sharing the same device_fingerprint
  multiAccountThreshold: 3,

  // Geofence: > N meters from expected store is a violation
  geofenceMaxMeters: 200,
};

// ── logSignal ──────────────────────────────────────────────
// Direct write to fraud_signals. No dedup, no rate limit (v1 — keep
// simple; revisit if table grows noisy). userId nullable so anonymous-
// scan attempts can also be logged when relevant.
const logSignal = async (userId, signalType, details = {}) => {
  await query(
    `INSERT INTO fraud_signals (user_id, signal_type, details)
     VALUES ($1, $2, $3)`,
    [userId || null, signalType, JSON.stringify(details)]
  );
};

// ── checkRapidBurst ────────────────────────────────────────
// Counts point_transactions for a user within the last W seconds.
// Returns { triggered, count, threshold } - caller decides what to do.
const checkRapidBurst = async (userId, opts = {}) => {
  const threshold = opts.threshold ?? DEFAULTS.rapidBurstThreshold;
  const windowSeconds = opts.windowSeconds ?? DEFAULTS.rapidBurstWindowSeconds;

  const result = await query(
    `SELECT COUNT(*)::int AS count
       FROM point_transactions
      WHERE user_id = $1
        AND created_at > NOW() - ($2 || ' seconds')::interval`,
    [userId, windowSeconds]
  );

  const count = result.rows[0]?.count || 0;
  return {
    triggered: count > threshold,
    count,
    threshold,
    windowSeconds,
  };
};

// ── checkMultiAccountByDevice ──────────────────────────────
// Counts distinct users sharing the same device_fingerprint as this
// user. Triggered when N+ users share a single device — likely
// alt-accounts. NULL fingerprints are ignored (most users won't have
// one for v1).
const checkMultiAccountByDevice = async (userId, opts = {}) => {
  const threshold = opts.threshold ?? DEFAULTS.multiAccountThreshold;

  const result = await query(
    `SELECT COUNT(DISTINCT id)::int AS count, device_fingerprint
       FROM users
      WHERE device_fingerprint = (
              SELECT device_fingerprint FROM users
               WHERE id = $1 AND device_fingerprint IS NOT NULL
            )
        AND device_fingerprint IS NOT NULL
      GROUP BY device_fingerprint`,
    [userId]
  );

  const count = result.rows[0]?.count || 0;
  const fingerprint = result.rows[0]?.device_fingerprint || null;

  return {
    triggered: count >= threshold,
    count,
    threshold,
    fingerprint,
  };
};

// ── checkGeofenceViolation ─────────────────────────────────
// Pure-function distance check (Haversine). Stateless — caller passes
// the user's GPS + the expected store's GPS. Useful for any flow that
// claims "I'm at this store" (zone recording, price scan, entrance map).
//
// Returns { triggered, distanceMeters, threshold }.
const checkGeofenceViolation = (userLat, userLng, storeLat, storeLng, opts = {}) => {
  const threshold = opts.maxMeters ?? DEFAULTS.geofenceMaxMeters;

  if (
    userLat == null || userLng == null ||
    storeLat == null || storeLng == null
  ) {
    // Missing coordinates = can't decide. Don't trigger; flag for manual.
    return { triggered: false, distanceMeters: null, threshold, reason: 'missing_coords' };
  }

  // Haversine
  const R = 6371000; // earth radius meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(storeLat - userLat);
  const dLng = toRad(storeLng - userLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(userLat)) * Math.cos(toRad(storeLat)) *
    Math.sin(dLng / 2) ** 2;
  const distanceMeters = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return {
    triggered: distanceMeters > threshold,
    distanceMeters: Math.round(distanceMeters),
    threshold,
  };
};

// ── analyzeAndLog ──────────────────────────────────────────
// Runs all relevant detectors for a user given context, and logs any
// triggered signals. Returns the list of signals that fired.
//
// Context fields (all optional - detectors that can't run for missing
// context just skip):
//   userLat, userLng        - for geofence check
//   expectedStoreLat, expectedStoreLng - for geofence check
//   action                  - human-readable action label for details
const analyzeAndLog = async (userId, context = {}) => {
  const fired = [];

  // Rapid burst (always runs if userId present)
  if (userId) {
    const burst = await checkRapidBurst(userId);
    if (burst.triggered) {
      await logSignal(userId, 'rapid_action_burst', {
        action: context.action || null,
        count: burst.count,
        threshold: burst.threshold,
        windowSeconds: burst.windowSeconds,
      });
      fired.push('rapid_action_burst');
    }

    // Multi-account suspicion
    const multi = await checkMultiAccountByDevice(userId);
    if (multi.triggered) {
      await logSignal(userId, 'multi_account_suspicion', {
        action: context.action || null,
        count: multi.count,
        threshold: multi.threshold,
        // device_fingerprint intentionally NOT included in details for PII
      });
      fired.push('multi_account_suspicion');
    }
  }

  // Geofence violation (only if user provided coords)
  if (
    context.userLat != null && context.userLng != null &&
    context.expectedStoreLat != null && context.expectedStoreLng != null
  ) {
    const geo = checkGeofenceViolation(
      context.userLat, context.userLng,
      context.expectedStoreLat, context.expectedStoreLng,
    );
    if (geo.triggered) {
      await logSignal(userId, 'geofence_violation_attempt', {
        action: context.action || null,
        distanceMeters: geo.distanceMeters,
        threshold: geo.threshold,
        // Coordinates intentionally NOT included - PII per Avi's directive
      });
      fired.push('geofence_violation_attempt');
    }
  }

  return fired;
};

module.exports = {
  DEFAULTS,
  logSignal,
  checkRapidBurst,
  checkMultiAccountByDevice,
  checkGeofenceViolation,
  analyzeAndLog,
};
