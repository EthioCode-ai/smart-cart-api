// src/routes/storeLayouts.js
// ============================================================
// AR Store Layout Contribution System
// Production-grade routes for crowd-sourced store mapping
// ============================================================

const express = require('express');
const { query, transaction, successResponse, errorResponse } = require('../models/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// ── CONSTANTS ───────────────────────────────────────────────

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

const CONFIDENCE_INCREMENT = 5.0;   // Each confirmation adds this
const CONFIDENCE_DECREMENT = 10.0;  // Each report subtracts this
const CONFIDENCE_INITIAL = 50.0;    // Starting confidence for new data
const STALE_DAYS = 90;              // Data older than this gets reduced confidence

// ── HELPERS ─────────────────────────────────────────────────

// Award points to a user and return the new total
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

// Check if user is first to map this store
const checkFirstStoreBonus = async (userId, storeId) => {
  const existing = await query(
    `SELECT COUNT(*) as count FROM layout_contributions
     WHERE store_id = $1 AND user_id != $2`,
    [storeId, userId]
  );
  return parseInt(existing.rows[0].count) === 0;
};

// Update store layout stats
const updateStoreStats = async (storeId) => {
  await query(
    `INSERT INTO store_layout_stats (store_id, total_aisles, mapped_aisles, total_departments, total_products, total_contributions, unique_contributors, avg_confidence, last_contribution_at)
     SELECT
       $1,
       COUNT(DISTINCT sa.id),
       COUNT(DISTINCT sa.id) FILTER (WHERE sa.confidence_score >= 50),
       COUNT(DISTINCT ad.id),
       COUNT(DISTINCT ap.id),
       (SELECT COUNT(*) FROM layout_contributions WHERE store_id = $1 AND status = 'approved'),
       (SELECT COUNT(DISTINCT user_id) FROM layout_contributions WHERE store_id = $1),
       COALESCE(AVG(sa.confidence_score), 0),
       NOW()
     FROM store_aisles sa
     LEFT JOIN aisle_departments ad ON sa.id = ad.aisle_id
     LEFT JOIN aisle_products ap ON ad.id = ap.department_id
     WHERE sa.store_id = $1
     ON CONFLICT (store_id)
     DO UPDATE SET
       total_aisles = EXCLUDED.total_aisles,
       mapped_aisles = EXCLUDED.mapped_aisles,
       total_departments = EXCLUDED.total_departments,
       total_products = EXCLUDED.total_products,
       total_contributions = EXCLUDED.total_contributions,
       unique_contributors = EXCLUDED.unique_contributors,
       avg_confidence = EXCLUDED.avg_confidence,
       last_contribution_at = EXCLUDED.last_contribution_at,
       updated_at = NOW()`,
    [storeId]
  );
};

// Match OCR text to standard department names
const matchDepartments = async (ocrText) => {
  if (!ocrText || ocrText.trim().length === 0) return [];

  const text = ocrText.toLowerCase();

  const deptResult = await query(
    `SELECT department_name, display_name, common_aliases
     FROM department_reference
     ORDER BY sort_order`
  );

  const matched = [];
  for (const dept of deptResult.rows) {
    // Check department name
    if (text.includes(dept.department_name)) {
      matched.push(dept.department_name);
      continue;
    }
    // Check display name
    if (text.includes(dept.display_name.toLowerCase())) {
      matched.push(dept.department_name);
      continue;
    }
    // Check aliases
    const aliases = dept.common_aliases || [];
    for (const alias of aliases) {
      if (text.includes(alias.toLowerCase())) {
        matched.push(dept.department_name);
        break;
      }
    }
  }

  return [...new Set(matched)]; // deduplicate
};

// Check and award badges
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

// ═════════════════════════════════════════════════════════════
//  STORE LAYOUT ENDPOINTS
// ═════════════════════════════════════════════════════════════

// ── GET /api/store-layouts/:storeId ─────────────────────────
// Get the complete layout for a store (aisles, departments, products)

router.get('/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params;

    // Verify store exists
    const storeCheck = await query(
      'SELECT id, name, google_place_id FROM stores WHERE id = $1',
      [storeId]
    );

    if (storeCheck.rows.length === 0) {
      return errorResponse(res, 404, 'Store not found');
    }

    const store = storeCheck.rows[0];

    // Get entrances
    const entrancesResult = await query(
      `SELECT * FROM store_entrances WHERE store_id = $1 ORDER BY entrance_type`,
      [storeId]
    );

    // Get aisles with departments and products
    const aislesResult = await query(
      `SELECT
         sa.id as aisle_id, sa.aisle_number, sa.aisle_label,
         sa.position_index, sa.confidence_score as aisle_confidence,
         sa.verified_count as aisle_verified,
         ad.id as dept_id, ad.department_name, ad.confidence_score as dept_confidence,
         ap.id as product_id, ap.product_category, ap.product_subcategory
       FROM store_aisles sa
       LEFT JOIN aisle_departments ad ON sa.id = ad.aisle_id
       LEFT JOIN aisle_products ap ON ad.id = ap.department_id
       WHERE sa.store_id = $1 AND sa.confidence_score >= 20
       ORDER BY sa.position_index NULLS LAST, sa.aisle_number, ad.department_name`,
      [storeId]
    );

    // Group into nested structure
    const aislesMap = {};
    for (const row of aislesResult.rows) {
      if (!aislesMap[row.aisle_id]) {
        aislesMap[row.aisle_id] = {
          id: row.aisle_id,
          aisleNumber: row.aisle_number,
          aisleLabel: row.aisle_label,
          positionIndex: row.position_index,
          confidence: parseFloat(row.aisle_confidence),
          verifiedCount: row.aisle_verified,
          departments: {},
        };
      }

      if (row.dept_id && !aislesMap[row.aisle_id].departments[row.dept_id]) {
        aislesMap[row.aisle_id].departments[row.dept_id] = {
          id: row.dept_id,
          name: row.department_name,
          confidence: parseFloat(row.dept_confidence),
          products: [],
        };
      }

      if (row.product_id && row.dept_id) {
        aislesMap[row.aisle_id].departments[row.dept_id].products.push({
          id: row.product_id,
          category: row.product_category,
          subcategory: row.product_subcategory,
        });
      }
    }

    // Convert departments map to array
    const aisles = Object.values(aislesMap).map(aisle => ({
      ...aisle,
      departments: Object.values(aisle.departments),
    }));

    // Get stats
    const statsResult = await query(
      `SELECT * FROM store_layout_stats WHERE store_id = $1`,
      [storeId]
    );

    const stats = statsResult.rows[0] || {
      total_aisles: 0,
      mapped_aisles: 0,
      total_departments: 0,
      total_contributions: 0,
      unique_contributors: 0,
      avg_confidence: 0,
    };

    const entrances = entrancesResult.rows.map(e => ({
      id: e.id,
      type: e.entrance_type,
      description: e.position_description,
      latitude: parseFloat(e.latitude) || null,
      longitude: parseFloat(e.longitude) || null,
      verifiedCount: e.verified_count,
    }));

    successResponse(res, {
      store: {
        id: store.id,
        name: store.name,
        googlePlaceId: store.google_place_id,
      },
      layout: {
        entrances,
        aisles,
        stats: {
          totalAisles: stats.total_aisles,
          mappedAisles: stats.mapped_aisles,
          totalDepartments: stats.total_departments,
          totalContributions: stats.total_contributions,
          uniqueContributors: stats.unique_contributors,
          avgConfidence: parseFloat(stats.avg_confidence) || 0,
          completionPercentage: stats.total_aisles > 0
            ? Math.round((stats.mapped_aisles / stats.total_aisles) * 100)
            : 0,
        },
      },
    });
  } catch (error) {
    console.error('Get store layout error:', error);
    errorResponse(res, 500, 'Failed to fetch store layout');
  }
});

// ── POST /api/store-layouts/:storeId/aisles ─────────────────
// Add a new aisle to a store (manual tagging)

router.post('/:storeId/aisles', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { aisleNumber, aisleLabel, departments, positionIndex } = req.body;

    if (!aisleNumber) {
      return errorResponse(res, 400, 'Aisle number is required');
    }

    // Verify store exists
    const storeCheck = await query('SELECT id FROM stores WHERE id = $1', [storeId]);
    if (storeCheck.rows.length === 0) {
      return errorResponse(res, 404, 'Store not found');
    }

    const result = await transaction(async (client) => {
      // Check if aisle already exists
      const existing = await client.query(
        'SELECT id FROM store_aisles WHERE store_id = $1 AND aisle_number = $2',
        [storeId, aisleNumber.toString()]
      );

      let aisleId;
      let isNew = false;

      if (existing.rows.length > 0) {
        // Aisle exists — increment confidence and verified count
        aisleId = existing.rows[0].id;
        await client.query(
          `UPDATE store_aisles SET
             confidence_score = LEAST(confidence_score + $1, 100),
             verified_count = verified_count + 1,
             aisle_label = COALESCE($2, aisle_label),
             last_verified_at = NOW(),
             updated_at = NOW()
           WHERE id = $3`,
          [CONFIDENCE_INCREMENT, aisleLabel, aisleId]
        );
      } else {
        // Create new aisle
        isNew = true;
        const aisleResult = await client.query(
          `INSERT INTO store_aisles (store_id, aisle_number, aisle_label, position_index, confidence_score, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [storeId, aisleNumber.toString(), aisleLabel, positionIndex, CONFIDENCE_INITIAL, req.user.id]
        );
        aisleId = aisleResult.rows[0].id;
      }

      // Add departments if provided
      const addedDepts = [];
      if (departments && departments.length > 0) {
        for (const deptName of departments) {
          const normalized = deptName.toLowerCase().trim();
          try {
            const deptResult = await client.query(
              `INSERT INTO aisle_departments (aisle_id, store_id, department_name, confidence_score, created_by)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (aisle_id, department_name)
               DO UPDATE SET
                 confidence_score = LEAST(aisle_departments.confidence_score + $6, 100),
                 verified_count = aisle_departments.verified_count + 1,
                 last_verified_at = NOW(),
                 updated_at = NOW()
               RETURNING id, department_name`,
              [aisleId, storeId, normalized, CONFIDENCE_INITIAL, req.user.id, CONFIDENCE_INCREMENT]
            );
            addedDepts.push(deptResult.rows[0]);
          } catch (deptErr) {
            console.error('Failed to add department:', deptName, deptErr.message);
          }
        }
      }

      // Record contribution
      const contribResult = await client.query(
        `INSERT INTO layout_contributions (store_id, user_id, aisle_id, contribution_type, data, status, points_awarded)
         VALUES ($1, $2, $3, 'manual', $4, 'approved', $5)
         RETURNING id`,
        [storeId, req.user.id, aisleId, JSON.stringify({ aisleNumber, aisleLabel, departments }), POINT_VALUES.aisle_manual]
      );

      return { aisleId, isNew, addedDepts, contributionId: contribResult.rows[0].id };
    });

    // Award points
    const pointResult = await awardPoints(
      req.user.id,
      POINT_VALUES.aisle_manual,
      'aisle_manual',
      result.contributionId,
      storeId
    );

    // Check first store bonus
    if (await checkFirstStoreBonus(req.user.id, storeId)) {
      await awardPoints(req.user.id, POINT_VALUES.first_store_bonus, 'first_store_bonus', null, storeId);
      pointResult.totalPoints += POINT_VALUES.first_store_bonus;
      pointResult.bonuses = [{ type: 'first_store_bonus', points: POINT_VALUES.first_store_bonus }];
    }

    // Update stats and check badges
    await updateStoreStats(storeId);
    const badges = await checkBadges(req.user.id, storeId);

    successResponse(res, {
      aisle: {
        id: result.aisleId,
        aisleNumber,
        aisleLabel,
        isNew: result.isNew,
        departments: result.addedDepts,
      },
      points: pointResult,
      badges,
    }, 201);
  } catch (error) {
    console.error('Add aisle error:', error);
    errorResponse(res, 500, 'Failed to add aisle');
  }
});

// ── POST /api/store-layouts/:storeId/aisles/scan ────────────
// Submit an OCR scan of an aisle sign

router.post('/:storeId/aisles/scan', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { aisleNumber, ocrConfidence, imageUrl } = req.body;
    // Truncate OCR text to fit VARCHAR(255) column
    const ocrText = (req.body.ocrText || '').substring(0, 250);

    if (!aisleNumber || !ocrText) {
      return errorResponse(res, 400, 'Aisle number and OCR text are required');
    }

    // Verify store exists
    const storeCheck = await query('SELECT id FROM stores WHERE id = $1', [storeId]);
    if (storeCheck.rows.length === 0) {
      return errorResponse(res, 404, 'Store not found');
    }

    // Match OCR text to departments
    const matchedDepartments = await matchDepartments(ocrText);

    const result = await transaction(async (client) => {
      // Upsert aisle
      const aisleResult = await client.query(
        `INSERT INTO store_aisles (store_id, aisle_number, aisle_label, confidence_score, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (store_id, aisle_number)
         DO UPDATE SET
           confidence_score = LEAST(store_aisles.confidence_score + $6, 100),
           aisle_label = COALESCE($3, store_aisles.aisle_label),
           verified_count = store_aisles.verified_count + 1,
           last_verified_at = NOW(),
           updated_at = NOW()
         RETURNING id, (xmax = 0) as is_new`,
        [storeId, aisleNumber.toString(), ocrText, CONFIDENCE_INITIAL + 10, req.user.id, CONFIDENCE_INCREMENT + 5]
      );

      const aisleId = aisleResult.rows[0].id;
      const isNew = aisleResult.rows[0].is_new;

      // Add matched departments
      const addedDepts = [];
      for (const deptName of matchedDepartments) {
        try {
          const deptResult = await client.query(
            `INSERT INTO aisle_departments (aisle_id, store_id, department_name, confidence_score, created_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (aisle_id, department_name)
             DO UPDATE SET
               confidence_score = LEAST(aisle_departments.confidence_score + $6, 100),
               verified_count = aisle_departments.verified_count + 1,
               last_verified_at = NOW(),
               updated_at = NOW()
             RETURNING id, department_name`,
            [aisleId, storeId, deptName, CONFIDENCE_INITIAL + 10, req.user.id, CONFIDENCE_INCREMENT + 5]
          );
          addedDepts.push(deptResult.rows[0]);

          // Auto-add common products for the department
          const deptRef = await client.query(
            `SELECT common_aliases FROM department_reference WHERE department_name = $1`,
            [deptName]
          );

          if (deptRef.rows.length > 0) {
            const aliases = deptRef.rows[0].common_aliases || [];
            for (const alias of aliases.slice(0, 5)) {
              try {
                await client.query(
                  `INSERT INTO aisle_products (department_id, product_category, created_by)
                   VALUES ($1, $2, $3)
                   ON CONFLICT (department_id, product_category) DO NOTHING`,
                  [deptResult.rows[0].id, alias, req.user.id]
                );
              } catch (prodErr) {
                // Ignore duplicates
              }
            }
          }
        } catch (deptErr) {
          console.error('Failed to add scanned department:', deptName, deptErr.message);
        }
      }

      // Record contribution
      const contribResult = await client.query(
        `INSERT INTO layout_contributions
           (store_id, user_id, aisle_id, contribution_type, ocr_text, ocr_confidence, image_url, data, status, points_awarded)
         VALUES ($1, $2, $3, 'scan', $4, $5, $6, $7, 'approved', $8)
         RETURNING id`,
        [
          storeId, req.user.id, aisleId, ocrText, ocrConfidence || null, imageUrl || null,
          JSON.stringify({ aisleNumber, matchedDepartments }), POINT_VALUES.aisle_scan,
        ]
      );

      return { aisleId, isNew, addedDepts, contributionId: contribResult.rows[0].id };
    });

    // Award points
    const pointResult = await awardPoints(
      req.user.id,
      POINT_VALUES.aisle_scan,
      'aisle_scan',
      result.contributionId,
      storeId
    );

    // Check first store bonus
    if (await checkFirstStoreBonus(req.user.id, storeId)) {
      await awardPoints(req.user.id, POINT_VALUES.first_store_bonus, 'first_store_bonus', null, storeId);
      pointResult.bonuses = [{ type: 'first_store_bonus', points: POINT_VALUES.first_store_bonus }];
    }

    // Update stats and check badges
    await updateStoreStats(storeId);
    const badges = await checkBadges(req.user.id, storeId);

    successResponse(res, {
      aisle: {
        id: result.aisleId,
        aisleNumber,
        isNew: result.isNew,
        departments: result.addedDepts,
        ocrMatches: matchedDepartments,
      },
      points: pointResult,
      badges,
    }, 201);
  } catch (error) {
    console.error('Scan aisle error:', error);
    errorResponse(res, 500, 'Failed to process aisle scan');
  }
});

// ── POST /api/store-layouts/:storeId/aisles/:aisleId/confirm
// Confirm existing aisle data is correct

router.post('/:storeId/aisles/:aisleId/confirm', async (req, res) => {
  try {
    const { storeId, aisleId } = req.params;
    const { departments } = req.body; // Optional: specific departments to confirm

    // Check aisle exists
    const aisleCheck = await query(
      'SELECT id FROM store_aisles WHERE id = $1 AND store_id = $2',
      [aisleId, storeId]
    );

    if (aisleCheck.rows.length === 0) {
      return errorResponse(res, 404, 'Aisle not found');
    }

    // Check user hasn't already confirmed this aisle recently (24h)
    const recentConfirm = await query(
      `SELECT id FROM layout_contributions
       WHERE store_id = $1 AND user_id = $2 AND aisle_id = $3
         AND contribution_type = 'confirm'
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [storeId, req.user.id, aisleId]
    );

    if (recentConfirm.rows.length > 0) {
      return errorResponse(res, 429, 'You already confirmed this aisle recently. Try again in 24 hours.');
    }

    await transaction(async (client) => {
      // Boost aisle confidence
      await client.query(
        `UPDATE store_aisles SET
           confidence_score = LEAST(confidence_score + $1, 100),
           verified_count = verified_count + 1,
           last_verified_at = NOW(),
           updated_at = NOW()
         WHERE id = $2`,
        [CONFIDENCE_INCREMENT, aisleId]
      );

      // Boost department confidence if specified
      if (departments && departments.length > 0) {
        for (const deptName of departments) {
          await client.query(
            `UPDATE aisle_departments SET
               confidence_score = LEAST(confidence_score + $1, 100),
               verified_count = verified_count + 1,
               last_verified_at = NOW(),
               updated_at = NOW()
             WHERE aisle_id = $2 AND department_name = $3`,
            [CONFIDENCE_INCREMENT, aisleId, deptName.toLowerCase()]
          );
        }
      } else {
        // Boost all departments for this aisle
        await client.query(
          `UPDATE aisle_departments SET
             confidence_score = LEAST(confidence_score + $1, 100),
             verified_count = verified_count + 1,
             last_verified_at = NOW(),
             updated_at = NOW()
           WHERE aisle_id = $2`,
          [CONFIDENCE_INCREMENT, aisleId]
        );
      }

      // Record contribution
      await client.query(
        `INSERT INTO layout_contributions (store_id, user_id, aisle_id, contribution_type, data, status, points_awarded)
         VALUES ($1, $2, $3, 'confirm', $4, 'approved', $5)`,
        [storeId, req.user.id, aisleId, JSON.stringify({ departments }), POINT_VALUES.aisle_confirm]
      );
    });

    // Award points
    const pointResult = await awardPoints(req.user.id, POINT_VALUES.aisle_confirm, 'aisle_confirm', null, storeId);

    // Update stats
    await updateStoreStats(storeId);

    successResponse(res, {
      message: 'Aisle data confirmed. Thank you!',
      points: pointResult,
    });
  } catch (error) {
    console.error('Confirm aisle error:', error);
    errorResponse(res, 500, 'Failed to confirm aisle');
  }
});

// ── POST /api/store-layouts/:storeId/aisles/:aisleId/report
// Report incorrect aisle data

router.post('/:storeId/aisles/:aisleId/report', async (req, res) => {
  try {
    const { storeId, aisleId } = req.params;
    const { reason, correctData } = req.body;

    if (!reason) {
      return errorResponse(res, 400, 'Report reason is required');
    }

    // Check aisle exists
    const aisleCheck = await query(
      'SELECT id FROM store_aisles WHERE id = $1 AND store_id = $2',
      [aisleId, storeId]
    );

    if (aisleCheck.rows.length === 0) {
      return errorResponse(res, 404, 'Aisle not found');
    }

    await transaction(async (client) => {
      // Reduce confidence
      await client.query(
        `UPDATE store_aisles SET
           confidence_score = GREATEST(confidence_score - $1, 0),
           updated_at = NOW()
         WHERE id = $2`,
        [CONFIDENCE_DECREMENT, aisleId]
      );

      // If correctData includes new departments, update them
      if (correctData && correctData.departments) {
        // Reduce confidence of existing departments
        await client.query(
          `UPDATE aisle_departments SET
             confidence_score = GREATEST(confidence_score - $1, 0),
             updated_at = NOW()
           WHERE aisle_id = $2`,
          [CONFIDENCE_DECREMENT, aisleId]
        );

        // Add corrected departments
        for (const deptName of correctData.departments) {
          await client.query(
            `INSERT INTO aisle_departments (aisle_id, store_id, department_name, confidence_score, created_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (aisle_id, department_name)
             DO UPDATE SET
               confidence_score = LEAST(aisle_departments.confidence_score + $6, 100),
               verified_count = aisle_departments.verified_count + 1,
               updated_at = NOW()`,
            [aisleId, storeId, deptName.toLowerCase(), CONFIDENCE_INITIAL, req.user.id, CONFIDENCE_INCREMENT]
          );
        }
      }

      // Record contribution
      await client.query(
        `INSERT INTO layout_contributions (store_id, user_id, aisle_id, contribution_type, data, status, points_awarded)
         VALUES ($1, $2, $3, 'report', $4, 'approved', $5)`,
        [storeId, req.user.id, aisleId, JSON.stringify({ reason, correctData }), POINT_VALUES.data_report]
      );
    });

    // Award points
    const pointResult = await awardPoints(req.user.id, POINT_VALUES.data_report, 'data_report', null, storeId);

    // Update stats
    await updateStoreStats(storeId);

    successResponse(res, {
      message: 'Report submitted. Thank you for improving the data!',
      points: pointResult,
    });
  } catch (error) {
    console.error('Report aisle error:', error);
    errorResponse(res, 500, 'Failed to submit report');
  }
});

// ── POST /api/store-layouts/:storeId/entrances ──────────────
// Add an entrance to a store

router.post('/:storeId/entrances', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { entranceType, positionDescription, latitude, longitude } = req.body;

    if (!entranceType) {
      return errorResponse(res, 400, 'Entrance type is required');
    }

    // Verify store exists
    const storeCheck = await query('SELECT id FROM stores WHERE id = $1', [storeId]);
    if (storeCheck.rows.length === 0) {
      return errorResponse(res, 404, 'Store not found');
    }

    const result = await query(
      `INSERT INTO store_entrances (store_id, entrance_type, position_description, latitude, longitude, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [storeId, entranceType, positionDescription, latitude, longitude, req.user.id]
    );

    // Record contribution
    const contribResult = await query(
      `INSERT INTO layout_contributions (store_id, user_id, contribution_type, data, status, points_awarded)
       VALUES ($1, $2, 'entrance', $3, 'approved', $4)
       RETURNING id`,
      [storeId, req.user.id, JSON.stringify({ entranceType, positionDescription }), POINT_VALUES.entrance_map]
    );

    // Award points
    const pointResult = await awardPoints(
      req.user.id,
      POINT_VALUES.entrance_map,
      'entrance_map',
      contribResult.rows[0].id,
      storeId
    );

    const entrance = result.rows[0];

    successResponse(res, {
      entrance: {
        id: entrance.id,
        type: entrance.entrance_type,
        description: entrance.position_description,
        latitude: parseFloat(entrance.latitude) || null,
        longitude: parseFloat(entrance.longitude) || null,
      },
      points: pointResult,
    }, 201);
  } catch (error) {
    console.error('Add entrance error:', error);
    errorResponse(res, 500, 'Failed to add entrance');
  }
});

// ── GET /api/store-layouts/:storeId/find-product ────────────
// Find which aisle a product is in

router.get('/:storeId/find-product', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { product } = req.query;

    if (!product || product.trim().length < 2) {
      return errorResponse(res, 400, 'Product name is required (min 2 characters)');
    }

    const searchTerm = product.toLowerCase().trim();

    // Search through aisle_products and department aliases
    const result = await query(
      `SELECT DISTINCT
         sa.aisle_number, sa.aisle_label, sa.confidence_score as aisle_confidence,
         ad.department_name, ad.confidence_score as dept_confidence,
         ap.product_category
       FROM store_aisles sa
       JOIN aisle_departments ad ON sa.id = ad.aisle_id
       LEFT JOIN aisle_products ap ON ad.id = ap.department_id
       WHERE sa.store_id = $1
         AND sa.confidence_score >= 30
         AND (
           ap.product_category ILIKE $2
           OR ap.product_subcategory ILIKE $2
           OR ad.department_name ILIKE $2
         )
       ORDER BY sa.confidence_score DESC, ad.confidence_score DESC`,
      [storeId, `%${searchTerm}%`]
    );

    // Also check department aliases
    const aliasResult = await query(
      `SELECT dr.department_name
       FROM department_reference dr
       WHERE $1 = ANY(SELECT LOWER(unnest(dr.common_aliases)))
          OR dr.department_name ILIKE $2
          OR dr.display_name ILIKE $2`,
      [searchTerm, `%${searchTerm}%`]
    );

    let aliasMatches = [];
    if (aliasResult.rows.length > 0) {
      const deptNames = aliasResult.rows.map(r => r.department_name);
      const aliasAisles = await query(
        `SELECT DISTINCT
           sa.aisle_number, sa.aisle_label, sa.confidence_score,
           ad.department_name
         FROM store_aisles sa
         JOIN aisle_departments ad ON sa.id = ad.aisle_id
         WHERE sa.store_id = $1 AND ad.department_name = ANY($2)
           AND sa.confidence_score >= 30
         ORDER BY sa.confidence_score DESC`,
        [storeId, deptNames]
      );
      aliasMatches = aliasAisles.rows;
    }

    // Combine and deduplicate
    const allResults = [...result.rows, ...aliasMatches];
    const seen = new Set();
    const unique = allResults.filter(r => {
      const key = `${r.aisle_number}-${r.department_name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    successResponse(res, {
      product: searchTerm,
      locations: unique.map(r => ({
        aisleNumber: r.aisle_number,
        aisleLabel: r.aisle_label,
        department: r.department_name,
        confidence: parseFloat(r.aisle_confidence || r.confidence_score),
        productCategory: r.product_category || null,
      })),
      found: unique.length > 0,
    });
  } catch (error) {
    console.error('Find product error:', error);
    errorResponse(res, 500, 'Failed to find product');
  }
});

// ═════════════════════════════════════════════════════════════
//  GAMIFICATION ENDPOINTS
// ═════════════════════════════════════════════════════════════

// ── GET /api/store-layouts/me/points ────────────────────────
// Get current user's points, level, and badges

router.get('/me/points', async (req, res) => {
  try {
    // Get points
    const pointsResult = await query(
      `SELECT up.*, lt.title as level_title
       FROM user_points up
       LEFT JOIN level_thresholds lt ON up.level = lt.level
       WHERE up.user_id = $1`,
      [req.user.id]
    );

    // Get badges
    const badgesResult = await query(
      `SELECT ub.*, s.name as store_name
       FROM user_badges ub
       LEFT JOIN stores s ON ub.store_id = s.id
       WHERE ub.user_id = $1
       ORDER BY ub.earned_at DESC`,
      [req.user.id]
    );

    // Get next level
    const points = pointsResult.rows[0] || { total_points: 0, level: 1, contributions_count: 0, stores_mapped: 0 };
    const nextLevelResult = await query(
      `SELECT level, min_points, title FROM level_thresholds
       WHERE level = $1 + 1`,
      [points.level]
    );

    // Get recent transactions
    const recentResult = await query(
      `SELECT pt.*, s.name as store_name
       FROM point_transactions pt
       LEFT JOIN stores s ON pt.store_id = s.id
       WHERE pt.user_id = $1
       ORDER BY pt.created_at DESC
       LIMIT 20`,
      [req.user.id]
    );

    const nextLevel = nextLevelResult.rows[0] || null;

    successResponse(res, {
      points: {
        total: points.total_points,
        level: points.level,
        levelTitle: points.level_title || 'Shopper',
        contributionsCount: points.contributions_count,
        storesMapped: points.stores_mapped,
        streakDays: points.streak_days || 0,
        nextLevel: nextLevel ? {
          level: nextLevel.level,
          title: nextLevel.title,
          pointsRequired: nextLevel.min_points,
          pointsNeeded: nextLevel.min_points - points.total_points,
        } : null,
      },
      badges: badgesResult.rows.map(b => ({
        type: b.badge_type,
        name: b.badge_name,
        description: b.badge_description,
        storeName: b.store_name,
        earnedAt: b.earned_at,
      })),
      recentActivity: recentResult.rows.map(t => ({
        points: t.points,
        reason: t.reason,
        storeName: t.store_name,
        createdAt: t.created_at,
      })),
    });
  } catch (error) {
    console.error('Get user points error:', error);
    errorResponse(res, 500, 'Failed to fetch points');
  }
});

// ── GET /api/store-layouts/leaderboard ──────────────────────
// Global and per-store leaderboard

router.get('/leaderboard/global', async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const result = await query(
      `SELECT up.total_points, up.level, up.contributions_count, up.stores_mapped,
              u.name, u.avatar_url,
              lt.title as level_title
       FROM user_points up
       JOIN users u ON up.user_id = u.id
       LEFT JOIN level_thresholds lt ON up.level = lt.level
       WHERE up.total_points > 0
       ORDER BY up.total_points DESC
       LIMIT $1`,
      [parseInt(limit)]
    );

    // Get current user's rank
    const rankResult = await query(
      `SELECT COUNT(*) + 1 as rank
       FROM user_points
       WHERE total_points > (
         SELECT COALESCE(total_points, 0) FROM user_points WHERE user_id = $1
       )`,
      [req.user.id]
    );

    successResponse(res, {
      leaderboard: result.rows.map((row, index) => ({
        rank: index + 1,
        name: row.name,
        avatarUrl: row.avatar_url,
        totalPoints: row.total_points,
        level: row.level,
        levelTitle: row.level_title,
        contributionsCount: row.contributions_count,
        storesMapped: row.stores_mapped,
      })),
      myRank: parseInt(rankResult.rows[0]?.rank) || null,
    });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    errorResponse(res, 500, 'Failed to fetch leaderboard');
  }
});

// ── GET /api/store-layouts/leaderboard/:storeId ─────────────
// Per-store leaderboard

router.get('/leaderboard/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { limit = 20 } = req.query;

    const result = await query(
      `SELECT
         u.name, u.avatar_url,
         COUNT(lc.id) as contributions,
         SUM(lc.points_awarded) as total_points
       FROM layout_contributions lc
       JOIN users u ON lc.user_id = u.id
       WHERE lc.store_id = $1 AND lc.status = 'approved'
       GROUP BY u.id, u.name, u.avatar_url
       ORDER BY total_points DESC
       LIMIT $2`,
      [storeId, parseInt(limit)]
    );

    successResponse(res, {
      storeId,
      leaderboard: result.rows.map((row, index) => ({
        rank: index + 1,
        name: row.name,
        avatarUrl: row.avatar_url,
        contributions: parseInt(row.contributions),
        totalPoints: parseInt(row.total_points),
      })),
    });
  } catch (error) {
    console.error('Get store leaderboard error:', error);
    errorResponse(res, 500, 'Failed to fetch store leaderboard');
  }
});

// ── GET /api/store-layouts/:storeId/contributions ───────────
// Get recent contributions for a store

router.get('/:storeId/contributions', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { limit = 20 } = req.query;

    const result = await query(
      `SELECT lc.*, u.name as contributor_name, u.avatar_url,
              sa.aisle_number
       FROM layout_contributions lc
       JOIN users u ON lc.user_id = u.id
       LEFT JOIN store_aisles sa ON lc.aisle_id = sa.id
       WHERE lc.store_id = $1 AND lc.status = 'approved'
       ORDER BY lc.created_at DESC
       LIMIT $2`,
      [storeId, parseInt(limit)]
    );

    successResponse(res, {
      contributions: result.rows.map(row => ({
        id: row.id,
        type: row.contribution_type,
        aisleNumber: row.aisle_number,
        ocrText: row.ocr_text,
        contributorName: row.contributor_name,
        contributorAvatar: row.avatar_url,
        pointsAwarded: row.points_awarded,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('Get contributions error:', error);
    errorResponse(res, 500, 'Failed to fetch contributions');
  }
});

// ── GET /api/store-layouts/departments ───────────────────────
// Get all standard department reference data

router.get('/departments/reference', async (req, res) => {
  try {
    const result = await query(
      `SELECT department_name, display_name, icon, color, common_aliases, sort_order
       FROM department_reference
       ORDER BY sort_order`
    );

    successResponse(res, {
      departments: result.rows.map(row => ({
        name: row.department_name,
        displayName: row.display_name,
        icon: row.icon,
        color: row.color,
        aliases: row.common_aliases || [],
      })),
    });
  } catch (error) {
    console.error('Get departments error:', error);
    errorResponse(res, 500, 'Failed to fetch departments');
  }
});

module.exports = router;