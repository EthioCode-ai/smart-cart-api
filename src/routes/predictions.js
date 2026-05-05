// src/routes/predictions.js
// ============================================================
// Prediction-driven endpoints (Track 2 / Phase 2).
//
// Day-1 surface: GET /api/predictions/list-suggestions — the banner
// that appears above the active shopping list ("Add to your list?")
// powered by the checked_list_items signal source. Items already on
// the target list are filtered out so the banner never duplicates.
//
// Banner defaults (per Avi's (c) decision, 2026-05-04):
//   source            = 'checked_list_items'  (stronger purchase proxy)
//   minOccurrences    = 3                     (higher confidence prompt)
//   urgencyThreshold  = 0.6                   (matches existing engine)
//   limit             = 4                     (4 chips in the banner)
//
// Future surface (commits 6+): /where-to-shop (Recommend-a-Store).
// ============================================================

const express = require('express');
const { successResponse, errorResponse } = require('../models/db');
const { authenticate } = require('../middleware/auth');
const predictionService = require('../services/predictionService');

const router = express.Router();
router.use(authenticate);

// ── GET /api/predictions/list-suggestions ─────────────────
// Query params:
//   list_id         (optional, string|uuid) — exclude items already on this list
//   source          (optional)              — defaults to 'checked_list_items'
//   limit           (optional, int 1–10)    — defaults to 4
//   min_occurrences (optional, int)         — overrides source default (3)
router.get('/list-suggestions', async (req, res) => {
  try {
    const listId = req.query.list_id || null;
    const source = req.query.source || 'checked_list_items';
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 10) : 4;
    const minOccRaw = parseInt(req.query.min_occurrences, 10);
    const minOccurrences = Number.isFinite(minOccRaw) ? Math.max(minOccRaw, 1) : undefined;

    const suggestions = await predictionService.getRestockSuggestions({
      userId: req.user.id,
      source,
      ...(minOccurrences !== undefined ? { minOccurrences } : {}),
      urgencyThreshold: 0.6,
      limit,
      excludeListId: listId,
    });

    return successResponse(res, {
      suggestions,
      count: suggestions.length,
      source,
      list_id: listId,
    });
  } catch (err) {
    if (err && err.message && err.message.startsWith('Unknown signal source')) {
      return errorResponse(res, 400, err.message);
    }
    console.error('[predictions] list-suggestions error:', err);
    return errorResponse(res, 500, 'Failed to load list suggestions');
  }
});

module.exports = router;
