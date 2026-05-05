// src/services/driveTimeService.js
// ============================================================
// Drive-time service for Recommend-a-Store (Track 2 commit 5).
//
// Wraps Google Distance Matrix with the drive_time_cache table
// (added in migration 2026_05_phase2_recommend_a_store.sql). Cache
// key matches the schema's composite PK:
//
//   (user_lat_bucket  NUMERIC(7,3),   -- ~100m granularity
//    user_lng_bucket  NUMERIC(8,3),
//    store_id         UUID,
//    time_bucket      VARCHAR(16))
//
// Time buckets (local time):
//   rush_morning   — 07:00–09:00
//   rush_evening   — 16:00–19:00
//   off_peak       — everything else
//
// TTL: 30 min. Cleanup cron runs every 5 min via startCleanupCron().
// ============================================================

const { query } = require('../models/db');

const TTL_MINUTES = 30;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Read at call time, not at module load — keeps tests simple and lets a
// late-arriving env var (e.g. dotenv reload) take effect without a restart.
function googleMapsKey() {
  return process.env.G_MAPS || '';
}

// Round to 3 decimals for the bucket. Storing as string keeps Postgres
// NUMERIC(7,3)/NUMERIC(8,3) happy without float precision drift.
function bucket(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Number(value).toFixed(3);
}

// Local-hour windows. Pass a Date for testability; defaults to now.
function timeBucket(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 7 && hour < 9) return 'rush_morning';
  if (hour >= 16 && hour < 19) return 'rush_evening';
  return 'off_peak';
}

// Look up a single (user, store, bucket) row. Returns null if miss
// or if cached row is older than TTL.
async function readCache({ latBucket, lngBucket, storeId, bucket: tBucket }) {
  const result = await query(
    `SELECT duration_seconds, distance_meters, cached_at
       FROM drive_time_cache
      WHERE user_lat_bucket = $1
        AND user_lng_bucket = $2
        AND store_id        = $3
        AND time_bucket     = $4
        AND cached_at > NOW() - INTERVAL '${TTL_MINUTES} minutes'
      LIMIT 1`,
    [latBucket, lngBucket, storeId, tBucket]
  );
  return result.rows[0] || null;
}

// Upsert a fresh cache row. Composite PK + ON CONFLICT keeps writes
// idempotent across simultaneous misses for the same key.
async function writeCache({ latBucket, lngBucket, storeId, bucket: tBucket, durationSeconds, distanceMeters }) {
  await query(
    `INSERT INTO drive_time_cache
       (user_lat_bucket, user_lng_bucket, store_id, time_bucket, duration_seconds, distance_meters, cached_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_lat_bucket, user_lng_bucket, store_id, time_bucket)
     DO UPDATE SET
       duration_seconds = EXCLUDED.duration_seconds,
       distance_meters  = EXCLUDED.distance_meters,
       cached_at        = EXCLUDED.cached_at`,
    [latBucket, lngBucket, storeId, tBucket, durationSeconds, distanceMeters]
  );
}

// Single Distance Matrix call. Caller batches keys to one URL when possible
// to keep within Google's per-request element budget (max 25 destinations).
// Returns one element per destination (same order). Failures bubble up so
// the caller can decide whether to fall back to Haversine.
async function callDistanceMatrix({ origin, destinations, departureNow = true }) {
  const key = googleMapsKey();
  if (!key) {
    throw new Error('G_MAPS env var not set');
  }
  const dest = destinations.map(d => `${d.lat},${d.lng}`).join('|');
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${origin.lat},${origin.lng}` +
    `&destinations=${encodeURIComponent(dest)}` +
    `&mode=driving` +
    (departureNow ? `&departure_time=now` : '') +
    `&key=${key}`;

  const response = await fetch(url);
  const data = await response.json();
  if (data.status !== 'OK') {
    throw new Error(`Distance Matrix status: ${data.status}`);
  }
  const row = data.rows?.[0];
  if (!row || !Array.isArray(row.elements)) {
    throw new Error('Distance Matrix returned no row/elements');
  }
  return row.elements.map(el => {
    if (el.status !== 'OK') return null;
    // Prefer duration_in_traffic when departure_time was set; falls back to duration.
    const duration = el.duration_in_traffic?.value ?? el.duration?.value ?? null;
    const distance = el.distance?.value ?? null;
    if (duration === null || distance === null) return null;
    return { durationSeconds: duration, distanceMeters: distance };
  });
}

// ── PUBLIC: getDriveTime ─────────────────────────────────────
// One user → one store. Returns:
//   { duration_seconds, distance_meters, cache_hit }
// or null if no key + no cache (caller should fall back to Haversine).
async function getDriveTime({ userLat, userLng, storeId, storeLat, storeLng, now = new Date() }) {
  const latBucket = bucket(userLat);
  const lngBucket = bucket(userLng);
  if (latBucket === null || lngBucket === null) return null;

  const tBucket = timeBucket(now);

  const cached = await readCache({ latBucket, lngBucket, storeId, bucket: tBucket });
  if (cached) {
    return {
      duration_seconds: cached.duration_seconds,
      distance_meters: cached.distance_meters,
      cache_hit: true,
    };
  }

  if (!googleMapsKey()) return null;

  const elements = await callDistanceMatrix({
    origin: { lat: userLat, lng: userLng },
    destinations: [{ lat: storeLat, lng: storeLng }],
  });
  const el = elements[0];
  if (!el) return null;

  await writeCache({
    latBucket,
    lngBucket,
    storeId,
    bucket: tBucket,
    durationSeconds: el.durationSeconds,
    distanceMeters: el.distanceMeters,
  });

  return {
    duration_seconds: el.durationSeconds,
    distance_meters: el.distanceMeters,
    cache_hit: false,
  };
}

// ── PUBLIC: getDriveTimes (batch) ─────────────────────────────
// One user → many stores. Hits cache for each, then makes a single
// Distance Matrix call for the misses. Preserves input order.
//
// stores: [{ id, lat, lng }, ...]   max 25 per call (DM API limit)
// returns: [{ store_id, duration_seconds, distance_meters, cache_hit } | null, ...]
async function getDriveTimes({ userLat, userLng, stores, now = new Date() }) {
  if (!Array.isArray(stores) || stores.length === 0) return [];
  const latBucket = bucket(userLat);
  const lngBucket = bucket(userLng);
  if (latBucket === null || lngBucket === null) return stores.map(() => null);

  const tBucket = timeBucket(now);

  // Phase 1: cache lookups in parallel
  const cacheRows = await Promise.all(
    stores.map(s => readCache({ latBucket, lngBucket, storeId: s.id, bucket: tBucket }))
  );

  const out = stores.map((s, i) => {
    const c = cacheRows[i];
    if (!c) return null;
    return {
      store_id: s.id,
      duration_seconds: c.duration_seconds,
      distance_meters: c.distance_meters,
      cache_hit: true,
    };
  });

  // Phase 2: collect misses, fetch in one DM call (capped at 25)
  const missIdx = [];
  for (let i = 0; i < stores.length; i++) {
    if (out[i] === null) missIdx.push(i);
  }
  if (missIdx.length === 0 || !googleMapsKey()) return out;

  const batchIdx = missIdx.slice(0, 25);
  const destinations = batchIdx.map(i => ({ lat: stores[i].lat, lng: stores[i].lng }));
  let elements = [];
  try {
    elements = await callDistanceMatrix({
      origin: { lat: userLat, lng: userLng },
      destinations,
    });
  } catch (err) {
    console.error('[driveTimeService] Distance Matrix batch failed:', err.message);
    return out; // misses stay null; caller falls back
  }

  // Phase 3: write cache + slot results back into output
  await Promise.all(batchIdx.map((origIdx, j) => {
    const el = elements[j];
    const s = stores[origIdx];
    if (!el) return Promise.resolve();
    out[origIdx] = {
      store_id: s.id,
      duration_seconds: el.durationSeconds,
      distance_meters: el.distanceMeters,
      cache_hit: false,
    };
    return writeCache({
      latBucket,
      lngBucket,
      storeId: s.id,
      bucket: tBucket,
      durationSeconds: el.durationSeconds,
      distanceMeters: el.distanceMeters,
    }).catch(err => {
      // Cache write failure is non-fatal — value still returned to caller.
      console.error('[driveTimeService] cache write failed:', err.message);
    });
  }));

  return out;
}

// ── PUBLIC: cleanupExpiredCache ──────────────────────────────
// Run by the cron (and exposed for manual / test use). Deletes rows
// older than TTL_MINUTES. Uses idx_drive_time_cleanup on cached_at.
async function cleanupExpiredCache() {
  const result = await query(
    `DELETE FROM drive_time_cache
      WHERE cached_at < NOW() - INTERVAL '${TTL_MINUTES} minutes'`,
  );
  return { deleted_count: result.rowCount || 0 };
}

// ── PUBLIC: startCleanupCron ────────────────────────────────
// In-process setInterval, fires every CLEANUP_INTERVAL_MS. Returns the
// timer handle so callers can stop it (tests, graceful shutdown).
// Lost-on-restart is acceptable per the migration's note: "cache is
// not authoritative."
function startCleanupCron() {
  const handle = setInterval(async () => {
    try {
      const { deleted_count } = await cleanupExpiredCache();
      if (deleted_count > 0) {
        console.log(`[driveTimeService] cleanup: deleted ${deleted_count} expired rows`);
      }
    } catch (err) {
      console.error('[driveTimeService] cleanup error:', err.message);
    }
  }, CLEANUP_INTERVAL_MS);
  // Don't keep the event loop alive on shutdown.
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}

module.exports = {
  getDriveTime,
  getDriveTimes,
  cleanupExpiredCache,
  startCleanupCron,
  // exported for tests / future extension
  bucket,
  timeBucket,
  TTL_MINUTES,
  CLEANUP_INTERVAL_MS,
};
