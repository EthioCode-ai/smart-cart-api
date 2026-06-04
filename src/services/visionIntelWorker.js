// src/services/visionIntelWorker.js
// ============================================================
// VEPI background sweep. Picks products with image_url but
// no product_intel yet, runs them through extractProductIntel,
// writes the JSONB result back to products.product_intel.
//
// Same pattern as SCA's categorizationWorker:
//   - In-process setInterval, 5 min cadence
//   - Small batches (10) because vision is slower than text-only
//   - Idempotent: re-runs on next interval if anything fails;
//     completed products are skipped (product_intel IS NULL filter)
//   - sweepInFlight guard so overlapping sweeps don't compound
//   - 42P01 (table/column missing) handled gracefully so the
//     worker doesn't crash on a fresh DB without the migration
//
// Cost dominated by GPT-4o-mini vision (~$0.005/product). Batch=10
// per sweep, every 5 min = max ~120 products/hour. ~312 products
// backfill in <3 hours wall-clock. New scans get processed in the
// next sweep after they hit the DB.
// ============================================================

const { query } = require('../models/db');
const { extractProductIntel } = require('./visionIntel');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 10;

let sweepInFlight = false;
let intervalHandle = null;

const sweepOnce = async () => {
  if (sweepInFlight) {
    return { skipped: true, reason: 'sweep_in_flight' };
  }
  sweepInFlight = true;
  const stats = { picked: 0, processed: 0, skipped_no_image: 0, errors: 0 };

  try {
    const pickResult = await query(
      `SELECT id, name, brand, image_url
         FROM products
        WHERE product_intel IS NULL
          AND image_url IS NOT NULL
          AND image_url <> ''
        ORDER BY updated_at DESC NULLS LAST
        LIMIT $1`,
      [BATCH_SIZE]
    );
    stats.picked = pickResult.rows.length;
    if (stats.picked === 0) {
      return stats;
    }

    for (const row of pickResult.rows) {
      try {
        const intel = await extractProductIntel(row.name, row.brand, row.image_url);
        if (!intel) {
          // Could be: vision disabled, parse failure, low quality image
          stats.errors += 1;
          continue;
        }
        await query(
          `UPDATE products SET product_intel = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(intel), row.id]
        );
        stats.processed += 1;
      } catch (err) {
        console.error(`VEPI worker: error processing product ${row.id} (${row.name}):`, err.message);
        stats.errors += 1;
      }
    }

    console.log(
      `VEPI sweep: picked=${stats.picked} processed=${stats.processed} errors=${stats.errors}`
    );
    return stats;
  } catch (err) {
    if (err.code !== '42P01' && err.code !== '42703') {
      // 42P01: relation missing; 42703: column missing (pre-migration).
      // Both: silently skip - the worker is safe to start before the
      // migration runs; it just won't do anything useful until it does.
      console.error('VEPI worker sweep error:', err.message);
    }
    return { picked: 0, error: err.message };
  } finally {
    sweepInFlight = false;
  }
};

const startVisionIntelWorker = () => {
  if (intervalHandle) return;
  setImmediate(() => {
    sweepOnce().catch(err => console.error('VEPI initial sweep error:', err.message));
  });
  intervalHandle = setInterval(() => {
    sweepOnce().catch(err => console.error('VEPI interval sweep error:', err.message));
  }, SWEEP_INTERVAL_MS);
  console.log(`VEPI worker started: sweeping every ${SWEEP_INTERVAL_MS / 1000}s, batch=${BATCH_SIZE}`);
};

const stopVisionIntelWorker = () => {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
};

module.exports = {
  startVisionIntelWorker,
  stopVisionIntelWorker,
  sweepOnce,
  SWEEP_INTERVAL_MS,
  BATCH_SIZE,
};
