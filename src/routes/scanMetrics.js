// src/routes/scanMetrics.js
// ============================================================
// Phase 0 scanner instrumentation sink (Avi green-lit 2026-05-19).
//
//   POST /api/scan-metrics          - record one completed scan
//   GET  /api/scan-metrics/summary  - aggregate -> guardrail trip-wires
//
// MEASUREMENT ONLY. PII-safe: accepts no prices, names, barcodes,
// images, or geo (see migration 2026_05_phase0_scan_metrics.sql).
// The recorder is best-effort on the client; this endpoint still
// validates so junk can't pollute the guardrail numbers.
// ============================================================

const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const SOURCES = new Set(['barcode', 'ocr_shelf', 'ocr_aisle']);
const KINDS = new Set(['price', 'name', 'both', 'aisle', 'department']);

// Guardrail trip-wires (Avi's numbers, 2026-05-19). One place to tune.
const TRIPWIRE = {
  correctionRate: 0.15,   // >15% of scans corrected -> OCR accuracy problem
  durationMs: 12000,      // median scan > 12s -> cumbersome
  tapCount: 4,            // median > 4 taps -> cumbersome
};

const isInt = (n) => Number.isInteger(n);
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

// ── POST /api/scan-metrics ────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      source, wasCorrected, correctionKind = null,
      correctionPct = null, durationMs, tapCount, appVersion = null,
    } = req.body || {};

    if (!SOURCES.has(source)) {
      return errorResponse(res, 400, `source must be one of: ${[...SOURCES].join(', ')}`);
    }
    if (typeof wasCorrected !== 'boolean') {
      return errorResponse(res, 400, 'wasCorrected (boolean) is required');
    }
    if (correctionKind !== null && !KINDS.has(correctionKind)) {
      return errorResponse(res, 400, `correctionKind must be null or one of: ${[...KINDS].join(', ')}`);
    }
    if (correctionPct !== null && !isNum(correctionPct)) {
      return errorResponse(res, 400, 'correctionPct must be a number or null');
    }
    if (!isInt(durationMs) || durationMs < 0) {
      return errorResponse(res, 400, 'durationMs (non-negative integer) is required');
    }
    if (!isInt(tapCount) || tapCount < 0) {
      return errorResponse(res, 400, 'tapCount (non-negative integer) is required');
    }

    const result = await query(
      `INSERT INTO scan_metrics
         (user_id, source, was_corrected, correction_kind,
          correction_pct, duration_ms, tap_count, app_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        req.user.id, source, wasCorrected, correctionKind,
        correctionPct, durationMs, tapCount,
        appVersion ? String(appVersion).slice(0, 16) : null,
      ]
    );
    return successResponse(res, { id: result.rows[0].id }, 201);
  } catch (err) {
    console.error('[scan-metrics] record error:', err);
    return errorResponse(res, 500, 'Failed to record scan metric');
  }
});

// ── GET /api/scan-metrics/summary ─────────────────────────
// ?window_days=14 (default), ?source=barcode|ocr_shelf|ocr_aisle
router.get('/summary', async (req, res) => {
  try {
    const wdRaw = parseInt(req.query.window_days, 10);
    const windowDays = Number.isFinite(wdRaw) ? Math.min(Math.max(wdRaw, 1), 365) : 14;
    const srcFilter = SOURCES.has(req.query.source) ? req.query.source : null;

    const params = [windowDays];
    let where = `created_at > NOW() - ($1 || ' days')::interval`;
    if (srcFilter) { params.push(srcFilter); where += ` AND source = $2`; }

    const agg = await query(
      `SELECT
         COUNT(*)::int                                              AS total,
         COALESCE(AVG(CASE WHEN was_corrected THEN 1 ELSE 0 END), 0) AS correction_rate,
         COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms), 0) AS median_duration_ms,
         COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tap_count), 0)   AS median_taps,
         COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY correction_pct)
                  FILTER (WHERE correction_pct IS NOT NULL), 0)      AS median_correction_pct
       FROM scan_metrics
       WHERE ${where}`,
      params
    );
    const bySource = await query(
      `SELECT source,
              COUNT(*)::int AS total,
              COALESCE(AVG(CASE WHEN was_corrected THEN 1 ELSE 0 END), 0) AS correction_rate,
              COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms), 0) AS median_duration_ms,
              COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tap_count), 0)   AS median_taps
         FROM scan_metrics
        WHERE ${where}
        GROUP BY source
        ORDER BY source`,
      params
    );

    const a = agg.rows[0];
    const correctionRate = parseFloat(a.correction_rate);
    const medianDurationMs = parseFloat(a.median_duration_ms);
    const medianTaps = parseFloat(a.median_taps);

    return successResponse(res, {
      windowDays,
      source: srcFilter || 'all',
      total: a.total,
      correctionRate,
      medianDurationMs,
      medianTaps,
      medianCorrectionPct: parseFloat(a.median_correction_pct),
      tripwires: TRIPWIRE,
      // Actionable: does the data say "revisit the approach"?
      flags: {
        correctionRateExceeded: a.total > 0 && correctionRate > TRIPWIRE.correctionRate,
        medianDurationExceeded: a.total > 0 && medianDurationMs > TRIPWIRE.durationMs,
        medianTapsExceeded: a.total > 0 && medianTaps > TRIPWIRE.tapCount,
      },
      bySource: bySource.rows.map((r) => ({
        source: r.source,
        total: r.total,
        correctionRate: parseFloat(r.correction_rate),
        medianDurationMs: parseFloat(r.median_duration_ms),
        medianTaps: parseFloat(r.median_taps),
      })),
    });
  } catch (err) {
    console.error('[scan-metrics] summary error:', err);
    return errorResponse(res, 500, 'Failed to compute scan-metrics summary');
  }
});

module.exports = router;
