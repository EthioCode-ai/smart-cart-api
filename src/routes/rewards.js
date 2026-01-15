const express = require('express');
const db = require('../db');

const router = express.Router();

// Get user's rewards
router.get('/mine', async (req, res) => {
  try {
    // For now, use placeholder user ID
    const userId = req.userId || '00000000-0000-0000-0000-000000000001';

    const result = await db.query(
      `SELECT 
        total_points_earned, total_points_redeemed, current_balance,
        total_contributions, total_aisles_mapped, total_stores_contributed,
        contributor_rank, badges, created_at
      FROM user_rewards
      WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      // Create initial rewards record
      await db.query(
        'INSERT INTO user_rewards (user_id) VALUES ($1)',
        [userId]
      );

      return res.json({
        success: true,
        data: {
          totalPointsEarned: 0,
          totalPointsRedeemed: 0,
          currentBalance: 0,
          totalContributions: 0,
          totalAislesMapped: 0,
          totalStoresContributed: 0,
          contributorRank: 'bronze',
          badges: []
        }
      });
    }

    const rewards = result.rows[0];

    res.json({
      success: true,
      data: {
        totalPointsEarned: rewards.total_points_earned,
        totalPointsRedeemed: rewards.total_points_redeemed,
        currentBalance: rewards.current_balance,
        totalContributions: rewards.total_contributions,
        totalAislesMapped: rewards.total_aisles_mapped,
        totalStoresContributed: rewards.total_stores_contributed,
        contributorRank: rewards.contributor_rank,
        badges: rewards.badges || [],
        memberSince: rewards.created_at
      }
    });
  } catch (error) {
    console.error('Get rewards error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch rewards' });
  }
});

// Get available rewards to redeem
router.get('/catalog', async (req, res) => {
  try {
    // Static catalog for now
    const catalog = [
      { id: '1', name: '$1 Off Coupon', pointsCost: 100, type: 'coupon', description: '$1 off your next purchase' },
      { id: '2', name: '$5 Off Coupon', pointsCost: 450, type: 'coupon', description: '$5 off your next purchase' },
      { id: '3', name: '$10 Off Coupon', pointsCost: 850, type: 'coupon', description: '$10 off your next purchase' },
      { id: '4', name: 'Free Delivery', pointsCost: 200, type: 'perk', description: 'Free delivery on your next order' },
      { id: '5', name: 'Premium Badge', pointsCost: 500, type: 'badge', description: 'Show off your contributor status' }
    ];

    res.json({ success: true, data: catalog });
  } catch (error) {
    console.error('Get catalog error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch catalog' });
  }
});

// Redeem points
router.post('/redeem', async (req, res) => {
  try {
    const userId = req.userId || '00000000-0000-0000-0000-000000000001';
    const { rewardType, pointsCost } = req.body;

    // Check balance
    const balanceResult = await db.query(
      'SELECT current_balance FROM user_rewards WHERE user_id = $1',
      [userId]
    );

    if (balanceResult.rows.length === 0 || balanceResult.rows[0].current_balance < pointsCost) {
      return res.status(400).json({ success: false, error: 'Insufficient points' });
    }

    // Deduct points
    const updateResult = await db.query(
      `UPDATE user_rewards 
       SET current_balance = current_balance - $2,
           total_points_redeemed = total_points_redeemed + $2,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING current_balance`,
      [userId, pointsCost]
    );

    // Generate coupon code (simplified)
    const couponCode = `SC-${Date.now().toString(36).toUpperCase()}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30); // 30 days expiry

    res.json({
      success: true,
      data: {
        redemptionId: `RED-${Date.now()}`,
        couponCode,
        expiresAt: expiresAt.toISOString(),
        newBalance: updateResult.rows[0].current_balance
      },
      message: `Reward redeemed! Your coupon code is ${couponCode}`
    });
  } catch (error) {
    console.error('Redeem error:', error);
    res.status(500).json({ success: false, error: 'Failed to redeem reward' });
  }
});

// Get leaderboard
router.get('/leaderboard', async (req, res) => {
  try {
    const { timeframe = 'month', limit = 20 } = req.query;

    // For now, get all-time leaderboard (timeframe filtering would need transaction dates)
    const result = await db.query(
      `SELECT 
        user_id,
        total_points_earned,
        total_contributions,
        total_stores_contributed,
        contributor_rank,
        ROW_NUMBER() OVER (ORDER BY total_points_earned DESC) as rank_position
      FROM user_rewards
      WHERE total_contributions > 0
      ORDER BY total_points_earned DESC
      LIMIT $1`,
      [limit]
    );

    res.json({
      success: true,
      data: result.rows.map(row => ({
        userId: row.user_id,
        username: `Contributor ${row.rank_position}`, // In production, join with users table
        totalPointsEarned: row.total_points_earned,
        totalContributions: row.total_contributions,
        totalStoresContributed: row.total_stores_contributed,
        contributorRank: row.contributor_rank,
        rankPosition: parseInt(row.rank_position)
      })),
      timeframe
    });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
});

// Get reward history
router.get('/history', async (req, res) => {
  try {
    const userId = req.userId || '00000000-0000-0000-0000-000000000001';

    // Get contributions as "earned" transactions
    const contributions = await db.query(
      `SELECT 
        id, 
        'earned' as type,
        points_earned + bonus_points as points,
        'Contribution' as description,
        created_at
      FROM layout_contributions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
      [userId]
    );

    res.json({
      success: true,
      data: contributions.rows.map(row => ({
        id: row.id,
        type: row.type,
        points: row.points,
        description: row.description,
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }
});

module.exports = router;
