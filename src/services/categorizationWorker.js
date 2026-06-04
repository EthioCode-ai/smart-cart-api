// src/services/categorizationWorker.js
// ============================================================
// SCA background sweep - periodically picks up uncategorized products
// (category = 'grocery' or NULL), runs them through the hybrid
// categorize() pipeline, and writes the result back to products.category.
//
// Avi-locked design (2026-06-03):
//   - Background, NOT sync on write. +200ms on Walk & Scan was rejected.
//   - Idempotent: a server restart loses nothing because jobs re-run
//     on the next sweep. Sweep query matches anything still 'grocery'.
//   - In-process setInterval - no queue infra (Render single-service).
//   - Small batches (default 25) so an AI rate-limit blip stalls one
//     sweep, not the whole pipeline.
//
// The dictionary path covers most products at ~0 cost. Only the long
// tail hits OpenAI (~$0.00015 per call). Backfill of all existing
// 'grocery' rows happens automatically as the worker runs.
// ============================================================

const { query } = require('../models/db');
const { categorize } = require('./categorization');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const BATCH_SIZE = 25;
const STALE_CATEGORY_VALUES = ["'grocery'"]; // products to backfill

let sweepInFlight = false;
let intervalHandle = null;

const sweepOnce = async () => {
  if (sweepInFlight) {
    // Prevent overlap if the previous sweep is still running (e.g., AI
    // latency, network blip). Next interval will retry.
    return { skipped: true, reason: 'sweep_in_flight' };
  }
  sweepInFlight = true;
  const stats = { picked: 0, dictionary: 0, ai: 0, fallback: 0, errors: 0 };

  try {
    const pickResult = await query(
      `SELECT id, name, brand
         FROM products
        WHERE category IS NULL OR category = 'grocery'
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
        const { category, method } = await categorize(row.name, row.brand);
        await query(
          `UPDATE products SET category = $1, updated_at = NOW() WHERE id = $2`,
          [category, row.id]
        );
        stats[method] = (stats[method] || 0) + 1;
      } catch (err) {
        console.error(`SCA worker: error categorizing product ${row.id} (${row.name}):`, err.message);
        stats.errors += 1;
      }
    }

    console.log(
      `SCA sweep: ${stats.picked} processed | dict=${stats.dictionary} ai=${stats.ai} fallback=${stats.fallback} errors=${stats.errors}`
    );
    return stats;
  } catch (err) {
    // Most common: products table missing on a fresh DB. Don't crash the
    // worker loop; let the next sweep retry.
    if (err.code !== '42P01') {
      console.error('SCA worker sweep error:', err.message);
    }
    return { picked: 0, error: err.message };
  } finally {
    sweepInFlight = false;
  }
};

const startCategorizationWorker = () => {
  if (intervalHandle) return; // already running
  // Kick off an immediate sweep so a freshly-deployed worker starts the
  // backfill without waiting 5 min.
  setImmediate(() => {
    sweepOnce().catch(err => console.error('SCA initial sweep error:', err.message));
  });
  intervalHandle = setInterval(() => {
    sweepOnce().catch(err => console.error('SCA interval sweep error:', err.message));
  }, SWEEP_INTERVAL_MS);
  console.log(`SCA worker started: sweeping every ${SWEEP_INTERVAL_MS / 1000}s, batch=${BATCH_SIZE}`);
};

const stopCategorizationWorker = () => {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
};

module.exports = {
  startCategorizationWorker,
  stopCategorizationWorker,
  sweepOnce,
  SWEEP_INTERVAL_MS,
  BATCH_SIZE,
  STALE_CATEGORY_VALUES,
};
