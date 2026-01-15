const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Points configuration
const POINTS = {
  AISLE: 10,
  SPECIAL_AREA: 5,
  PHOTO_BONUS: 5,
  CATEGORY_BONUS: 2
};

// Submit a layout contribution
router.post('/', [
  body('storeId').isUUID(),
  body('aisles').optional().isArray(),
  body('specialAreas').optional().isArray(),
  body('userLocation.latitude').isFloat(),
  body('userLocation.longitude').isFloat()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { storeId, aisles = [], specialAreas = [], userLocation, deviceId, deviceType } = req.body;
    
    // For now, use a placeholder user ID (in production, get from auth token)
    const userId = req.userId || '00000000-0000-0000-0000-000000000001';

    // Verify store exists
    const storeCheck = await db.query('SELECT id, name FROM stores WHERE id = $1', [storeId]);
    if (storeCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Store not found' });
    }

    // Start transaction
    const client = await db.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Create contribution record
      const contributionResult = await client.query(
        `INSERT INTO layout_contributions 
         (store_id, user_id, aisles_contributed, special_areas_contributed, 
          user_latitude, user_longitude, device_id, device_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved')
         RETURNING id`,
        [storeId, userId, aisles.length, specialAreas.length,
         userLocation.latitude, userLocation.longitude, deviceId, deviceType]
      );

      const contributionId = contributionResult.rows[0].id;
      let totalPoints = 0;
      let bonusPoints = 0;

      // Insert aisles
      for (const aisle of aisles) {
        await client.query(
          `INSERT INTO store_aisles (store_id, aisle_number, aisle_description, categories, photo_url)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (store_id, aisle_number) 
           DO UPDATE SET 
             aisle_description = COALESCE(EXCLUDED.aisle_description, store_aisles.aisle_description),
             categories = EXCLUDED.categories,
             contribution_count = store_aisles.contribution_count + 1,
             updated_at = NOW()`,
          [storeId, aisle.aisleNumber, aisle.description, aisle.categories || [], aisle.photoUrl]
        );

        totalPoints += POINTS.AISLE;
        if (aisle.photoUrl) bonusPoints += POINTS.PHOTO_BONUS;
        bonusPoints += (aisle.categories?.length || 0) * POINTS.CATEGORY_BONUS;
      }

      // Insert special areas
      for (const area of specialAreas) {
        await client.query(
          `INSERT INTO store_special_areas (store_id, area_type, area_name, photo_url)
           VALUES ($1, $2, $3, $4)`,
          [storeId, area.areaType, area.areaName, area.photoUrl]
        );

        totalPoints += POINTS.SPECIAL_AREA;
      }

      // Update contribution with points
      const finalPoints = totalPoints + bonusPoints;
      await client.query(
        `UPDATE layout_contributions 
         SET points_earned = $2, bonus_points = $3, photos_uploaded = $4, completed_at = NOW()
         WHERE id = $1`,
        [contributionId, totalPoints, bonusPoints, aisles.filter(a => a.photoUrl).length]
      );

      // Update user rewards
      const rewardsResult = await client.query(
        `INSERT INTO user_rewards (user_id, total_points_earned, current_balance, total_contributions, total_aisles_mapped, total_stores_contributed)
         VALUES ($1, $2, $2, 1, $3, 1)
         ON CONFLICT (user_id) DO UPDATE SET
           total_points_earned = user_rewards.total_points_earned + $2,
           current_balance = user_rewards.current_balance + $2,
           total_contributions = user_rewards.total_contributions + 1,
           total_aisles_mapped = user_rewards.total_aisles_mapped + $3,
           total_stores_contributed = user_rewards.total_stores_contributed + 1,
           updated_at = NOW()
         RETURNING current_balance, contributor_rank`,
        [userId, finalPoints, aisles.length]
      );

      // Update store mapping status
      const aisleCount = await client.query(
        'SELECT COUNT(*) FROM store_aisles WHERE store_id = $1',
        [storeId]
      );

      const coverage = Math.min(100, parseInt(aisleCount.rows[0].count) * 5); // 5% per aisle, max 100%
      
      await client.query(
        `UPDATE stores SET 
           is_mapped = true, 
           mapping_coverage_percent = $2,
           total_contributions = total_contributions + 1,
           last_mapped_at = NOW()
         WHERE id = $1`,
        [storeId, coverage]
      );

      await client.query('COMMIT');

      res.status(201).json({
        success: true,
        data: {
          contributionId,
          pointsEarned: totalPoints,
          bonusPoints,
          totalPoints: finalPoints,
          newBalance: rewardsResult.rows[0].current_balance,
          rank: rewardsResult.rows[0].contributor_rank
        },
        message: `Great job! You earned ${finalPoints} points for mapping ${aisles.length} aisles and ${specialAreas.length} special areas.`
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Submit contribution error:', error);
    res.status(500).json({ success: false, error: 'Failed to submit contribution' });
  }
});

// Get user's contributions
router.get('/mine', async (req, res) => {
  try {
    // For now, use placeholder user ID
    const userId = req.userId || '00000000-0000-0000-0000-000000000001';

    const result = await db.query(
      `SELECT 
        lc.id, lc.store_id, s.name as store_name,
        lc.aisles_contributed, lc.special_areas_contributed,
        lc.photos_uploaded, lc.points_earned, lc.bonus_points,
        lc.status, lc.created_at, lc.completed_at
      FROM layout_contributions lc
      JOIN stores s ON lc.store_id = s.id
      WHERE lc.user_id = $1
      ORDER BY lc.created_at DESC
      LIMIT 50`,
      [userId]
    );

    res.json({
      success: true,
      data: result.rows.map(row => ({
        id: row.id,
        storeId: row.store_id,
        storeName: row.store_name,
        aislesContributed: row.aisles_contributed,
        specialAreasContributed: row.special_areas_contributed,
        photosUploaded: row.photos_uploaded,
        pointsEarned: row.points_earned + row.bonus_points,
        status: row.status,
        createdAt: row.created_at,
        completedAt: row.completed_at
      }))
    });
  } catch (error) {
    console.error('Get contributions error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch contributions' });
  }
});

// Report layout issue
router.post('/:storeId/report', [
  body('type').isIn(['wrong_aisle', 'missing_aisle', 'outdated', 'other']),
  body('description').trim().notEmpty()
], async (req, res) => {
  try {
    const { storeId } = req.params;
    const { type, aisleId, description } = req.body;

    // For now, just log the report (in production, store in a reports table)
    console.log('Layout issue reported:', { storeId, type, aisleId, description });

    res.json({
      success: true,
      message: 'Thank you for reporting this issue. We will review it shortly.'
    });
  } catch (error) {
    console.error('Report issue error:', error);
    res.status(500).json({ success: false, error: 'Failed to submit report' });
  }
});

module.exports = router;
