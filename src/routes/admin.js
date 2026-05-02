// src/routes/admin.js
// ============================================================
// Admin endpoints — pre-launch operator tools
//
// Auth: `authenticate` middleware only. Pre-launch this is fine because
// Avi is the sole operator and the only authenticated user. Before adding
// more users, GATE this with an `is_admin` column or role check.
// ============================================================

const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate } = require('../middleware/auth');
const { promotePending } = require('../services/marketPriceWriter');

const router = express.Router();

// ── GET /api/admin/pending-prices ───────────────────────────
// List quarantined market_prices writes, newest first.
// Query params:
//   limit  (default 100, max 500)
//   offset (default 0)
//   reason (optional: 'low_confidence' | 'awaiting_corroboration')
router.get('/pending-prices', authenticate, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const reason = req.query.reason || null;

    const params = [limit, offset];
    let whereClause = '';
    if (reason) {
      whereClause = 'WHERE p.quarantine_reason = $3';
      params.push(reason);
    }

    const result = await query(
      `SELECT
         p.id, p.barcode, p.price, p.unit_price, p.regular_price,
         p.latitude, p.longitude, p.source, p.scanned_by,
         p.confidence, p.quarantine_reason, p.existing_market_price_id,
         p.created_at,
         pr.name        AS product_name,
         pr.brand       AS product_brand,
         existing.price AS existing_zone_price
       FROM market_prices_pending p
       LEFT JOIN products      pr       ON pr.barcode = p.barcode
       LEFT JOIN market_prices existing ON existing.id = p.existing_market_price_id
       ${whereClause}
       ORDER BY p.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*)::int AS total FROM market_prices_pending
       ${reason ? 'WHERE quarantine_reason = $1' : ''}`,
      reason ? [reason] : []
    );

    successResponse(res, {
      total: countResult.rows[0].total,
      limit,
      offset,
      rows: result.rows.map(r => ({
        id: r.id,
        barcode: r.barcode,
        price: parseFloat(r.price),
        unitPrice: r.unit_price ? parseFloat(r.unit_price) : null,
        regularPrice: r.regular_price ? parseFloat(r.regular_price) : null,
        latitude: parseFloat(r.latitude),
        longitude: parseFloat(r.longitude),
        source: r.source,
        scannedBy: r.scanned_by,
        confidence: r.confidence != null ? parseFloat(r.confidence) : null,
        quarantineReason: r.quarantine_reason,
        existingMarketPriceId: r.existing_market_price_id,
        existingZonePrice: r.existing_zone_price != null ? parseFloat(r.existing_zone_price) : null,
        productName: r.product_name,
        productBrand: r.product_brand,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('Admin list pending error:', err.message);
    errorResponse(res, 500, 'Failed to list pending prices');
  }
});

// ── POST /api/admin/pending-prices/:id/promote ──────────────
// Manually approve a quarantined row, moving it into market_prices.
// Bypasses validator; recorded in market_prices_history as 'admin_override'.
router.post('/pending-prices/:id/promote', authenticate, async (req, res) => {
  try {
    const result = await promotePending(req.params.id);
    if (!result.promoted) {
      return errorResponse(res, 404, result.reason || 'Pending row not found');
    }
    successResponse(res, { promoted: true, marketPriceId: result.marketPriceId });
  } catch (err) {
    console.error('Admin promote error:', err.message);
    errorResponse(res, 500, 'Failed to promote pending price');
  }
});

// ── DELETE /api/admin/pending-prices/:id ────────────────────
// Reject a quarantined row outright (e.g. operator confirmed it's a bad scan).
// Hard delete; history table is for promoted/accepted writes only.
router.delete('/pending-prices/:id', authenticate, async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM market_prices_pending WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Pending row not found');
    }
    successResponse(res, { rejected: true, id: result.rows[0].id });
  } catch (err) {
    console.error('Admin reject error:', err.message);
    errorResponse(res, 500, 'Failed to reject pending price');
  }
});

module.exports = router;
