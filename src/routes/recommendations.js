// src/routes/recommendations.js
// ============================================================
// GET /api/recommendations/where-to-shop
//
// Recommend-a-Store endpoint. Three gates fire IN ORDER (the order
// matters for telemetry — we count gated reasons without exposing
// any individual user's settings):
//
//   1. CONSENT GATE
//      user_settings.recommend_stores_enabled must be true.
//      NULL (never answered) and false (explicitly opted out) both
//      short-circuit to "user_not_opted_in" with zero downstream
//      work. Settings-only opt-in surface; never auto-prompted.
//
//   2. ALLERGEN/DIETARY SAFETY GATE  (Option 2 — locked 2026-05-04)
//      If user_settings.allergens / dietary_restrictions OR any
//      family_members row has either array non-empty, return
//      "allergen_safety_unavailable" with a user-facing message
//      and {disable_allergen_tracking | wait} actions. Reasoning:
//      voice/text-added list items lack allergen metadata, so we
//      can't safely filter the basket. Honest household-level
//      refusal beats a silent partial filter — fail-safe over
//      fail-quiet.
//
//   3. ENGINE
//      recommendationService.getRecommendations(...). Returns
//      candidates, preferred/alternative, banner trigger, mode A/B/C.
// ============================================================

const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate } = require('../middleware/auth');
const recommendationService = require('../services/recommendationService');

const router = express.Router();
router.use(authenticate);

// ── Combined consent + restrictions lookup ────────────────
// One round trip instead of three: consent flag + user-level
// allergen/dietary counts + a SUM across the user's family_members
// rows. Returns null if the user has no user_settings row at all.
async function _loadGateState(userId) {
  const result = await query(
    `SELECT
       us.recommend_stores_enabled,
       COALESCE(array_length(us.allergens,            1), 0) AS user_allergen_count,
       COALESCE(array_length(us.dietary_restrictions, 1), 0) AS user_dietary_count,
       COALESCE((
         SELECT SUM(
           COALESCE(array_length(fm.allergens,            1), 0) +
           COALESCE(array_length(fm.dietary_restrictions, 1), 0)
         )
         FROM family_members fm
         WHERE fm.user_id = us.user_id
       ), 0) AS family_restriction_count
     FROM user_settings us
     WHERE us.user_id = $1`,
    [userId]
  );
  if (result.rows.length === 0) {
    // No user_settings row exists → never set anything → treat as
    // not opted in. (Settings auth path INSERTs a default row, so
    // this should be rare in production, but it's the safe default.)
    return null;
  }
  const r = result.rows[0];
  const householdRestrictionCount =
    parseInt(r.user_allergen_count) +
    parseInt(r.user_dietary_count) +
    parseInt(r.family_restriction_count);
  return {
    consented: r.recommend_stores_enabled === true,
    householdRestrictionCount,
  };
}

// ── GET /api/recommendations/where-to-shop ────────────────
router.get('/where-to-shop', async (req, res) => {
  try {
    const listId = req.query.list_id || null;
    const userLat = req.query.lat !== undefined ? parseFloat(req.query.lat) : null;
    const userLng = req.query.lng !== undefined ? parseFloat(req.query.lng) : null;
    const radiusRaw = parseFloat(req.query.radius_km);
    const radiusKm = Number.isFinite(radiusRaw) && radiusRaw > 0 ? Math.min(radiusRaw, 25) : undefined;
    const limitRaw = parseInt(req.query.candidate_limit, 10);
    const candidateLimit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 10) : undefined;

    if (!listId) {
      return errorResponse(res, 400, 'list_id is required');
    }
    if (userLat === null || userLng === null || Number.isNaN(userLat) || Number.isNaN(userLng)) {
      return errorResponse(res, 400, 'lat and lng are required');
    }

    // 1. CONSENT GATE
    const gate = await _loadGateState(req.user.id);
    if (!gate || !gate.consented) {
      return successResponse(res, {
        enabled: false,
        reason: 'user_not_opted_in',
      });
    }

    // 2. ALLERGEN/DIETARY SAFETY GATE
    // Message refined 2026-05-05 per Avi: acknowledge v1.1 timeline so
    // affected users see this as a known-coming feature, not a wall.
    // Reason key + actions kept stable so the frontend's switch doesn't
    // re-render on copy changes.
    if (gate.householdRestrictionCount > 0) {
      return successResponse(res, {
        enabled: true,
        blocked: true,
        reason: 'allergen_safety_unavailable',
        message: "Allergen filtering is coming in our next update — until then we can't safely recommend stores for households with allergens recorded.",
        actions: ['disable_allergen_tracking', 'wait'],
      });
    }

    // 3. ENGINE
    const result = await recommendationService.getRecommendations({
      userId: req.user.id,
      listId,
      userLat,
      userLng,
      ...(radiusKm !== undefined ? { radiusKm } : {}),
      ...(candidateLimit !== undefined ? { candidateLimit } : {}),
    });

    return successResponse(res, {
      enabled: true,
      blocked: false,
      ...result,
    });
  } catch (err) {
    if (err && err.message === 'list not found') {
      return errorResponse(res, 404, 'list not found');
    }
    console.error('[recommendations] where-to-shop error:', err);
    return errorResponse(res, 500, 'Failed to load recommendations');
  }
});

module.exports = router;
