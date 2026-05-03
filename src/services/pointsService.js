// src/services/pointsService.js
// ============================================================
// Points + badges service
//
// Extracted from src/routes/storeLayouts.js (commit pre-PR2) where these
// helpers were inline. Logic is IDENTICAL to the original — this is a pure
// move-first-cleanup-later refactor per the Phase 2 discipline note.
//
// Future cleanup (separate commits):
//   - Drive POINT_VALUES from the `point_values` DB table instead of
//     duplicating the constant here. The two have already drifted
//     (DB has weekly_challenge: 100; this constant doesn't).
//   - Add cooldown / daily-cap enforcement before awarding (anti-fraud
//     Layer 1 from the Phase 2 design).
//   - Wire fraudDetector.logSignal() on suspicious patterns.
//
// Used by:
//   - src/routes/storeLayouts.js  (existing — layout-side actions)
//   - src/routes/products.js      (incoming PR 2 commit 3 — price-side actions)
// ============================================================

const { query } = require('../models/db');

// ── CONSTANTS ───────────────────────────────────────────────

// Mirror of `point_values` table seed values. NOTE: this is duplicated
// data; DB is the source of truth long-term. See cleanup note above.
const POINT_VALUES = {
  aisle_scan: 50,
  aisle_manual: 30,
  aisle_confirm: 10,
  data_report: 15,
  entrance_map: 25,
  first_store_bonus: 200,
  store_complete_bonus: 500,
  streak_bonus: 25,
};

// ── awardPoints ─────────────────────────────────────────────
// Insert a transaction record + upsert user_points (cumulative +
// contributions_count) + recompute level from level_thresholds.
//
// Returns { totalPoints, points }.
const awardPoints = async (userId, points, reason, contributionId = null, storeId = null) => {
  // Insert transaction record
  await query(
    `INSERT INTO point_transactions (user_id, points, reason, contribution_id, store_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, points, reason, contributionId, storeId]
  );

  // Upsert user_points
  const result = await query(
    `INSERT INTO user_points (user_id, total_points, contributions_count, last_contribution_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       total_points = user_points.total_points + $2,
       contributions_count = user_points.contributions_count + 1,
       last_contribution_at = NOW(),
       updated_at = NOW()
     RETURNING total_points, contributions_count`,
    [userId, points]
  );

  const totalPoints = result.rows[0].total_points;

  // Check and update level
  const levelResult = await query(
    `SELECT level, title FROM level_thresholds
     WHERE min_points <= $1
     ORDER BY level DESC LIMIT 1`,
    [totalPoints]
  );

  if (levelResult.rows.length > 0) {
    const newLevel = levelResult.rows[0].level;
    await query(
      `UPDATE user_points SET level = $1 WHERE user_id = $2 AND level < $1`,
      [newLevel, userId]
    );
  }

  return { totalPoints, points };
};

// ── checkFirstStoreBonus ────────────────────────────────────
// Check if user is first to map this store (no prior contributions
// from any other user). Returns boolean.
const checkFirstStoreBonus = async (userId, storeId) => {
  const existing = await query(
    `SELECT COUNT(*) as count FROM layout_contributions
     WHERE store_id = $1 AND user_id != $2`,
    [storeId, userId]
  );
  return parseInt(existing.rows[0].count) === 0;
};

// ── checkBadges ─────────────────────────────────────────────
// Award any badges newly earned by this user, optionally scoped to a
// specific store. Returns array of newly-awarded badge rows.
const checkBadges = async (userId, storeId) => {
  const badges = [];

  // Store Expert: mapped 80%+ of a store
  const statsResult = await query(
    `SELECT total_aisles, mapped_aisles FROM store_layout_stats WHERE store_id = $1`,
    [storeId]
  );

  if (statsResult.rows.length > 0) {
    const stats = statsResult.rows[0];
    if (stats.total_aisles > 0 && (stats.mapped_aisles / stats.total_aisles) >= 0.8) {
      const badgeResult = await query(
        `INSERT INTO user_badges (user_id, badge_type, badge_name, badge_description, store_id)
         VALUES ($1, 'store_expert', 'Store Expert', 'Mapped 80% or more of a store layout', $2)
         ON CONFLICT (user_id, badge_type, store_id) DO NOTHING
         RETURNING *`,
        [userId, storeId]
      );
      if (badgeResult.rows.length > 0) badges.push(badgeResult.rows[0]);
    }
  }

  // First Explorer: first contribution ever
  const pointsResult = await query(
    `SELECT contributions_count FROM user_points WHERE user_id = $1`,
    [userId]
  );

  if (pointsResult.rows.length > 0 && pointsResult.rows[0].contributions_count === 1) {
    const badgeResult = await query(
      `INSERT INTO user_badges (user_id, badge_type, badge_name, badge_description)
       VALUES ($1, 'first_explorer', 'First Explorer', 'Made your first store layout contribution')
       ON CONFLICT (user_id, badge_type, store_id) DO NOTHING
       RETURNING *`,
      [userId]
    );
    if (badgeResult.rows.length > 0) badges.push(badgeResult.rows[0]);
  }

  // 10 Contributions
  if (pointsResult.rows.length > 0 && pointsResult.rows[0].contributions_count >= 10) {
    const badgeResult = await query(
      `INSERT INTO user_badges (user_id, badge_type, badge_name, badge_description)
       VALUES ($1, 'contributor_10', 'Dedicated Mapper', 'Made 10 store layout contributions')
       ON CONFLICT (user_id, badge_type, store_id) DO NOTHING
       RETURNING *`,
      [userId]
    );
    if (badgeResult.rows.length > 0) badges.push(badgeResult.rows[0]);
  }

  // 50 Contributions
  if (pointsResult.rows.length > 0 && pointsResult.rows[0].contributions_count >= 50) {
    const badgeResult = await query(
      `INSERT INTO user_badges (user_id, badge_type, badge_name, badge_description)
       VALUES ($1, 'contributor_50', 'Master Cartographer', 'Made 50 store layout contributions')
       ON CONFLICT (user_id, badge_type, store_id) DO NOTHING
       RETURNING *`,
      [userId]
    );
    if (badgeResult.rows.length > 0) badges.push(badgeResult.rows[0]);
  }

  return badges;
};

module.exports = {
  POINT_VALUES,
  awardPoints,
  checkFirstStoreBonus,
  checkBadges,
};
