// src/routes/dashboard.js
// ============================================================
// Dashboard Routes
// ============================================================

const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// ── GET /api/dashboard ──────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    // Get stats
    const statsResult = await query(
      `SELECT
        (SELECT COUNT(*) FROM list_items li
         JOIN shopping_lists sl ON li.list_id = sl.id
         WHERE sl.user_id = $1
         AND li.created_at >= date_trunc('month', NOW())) as items_this_month,
        (SELECT COUNT(*) FROM shopping_trips
         WHERE user_id = $1
         AND trip_date >= date_trunc('month', NOW())) as trips_this_month,
        (SELECT COALESCE(SUM(max_price - min_price), 0)
         FROM (
           SELECT li.barcode,
                  MAX(sp.price) as max_price,
                  MIN(sp.price) as min_price
           FROM list_items li
           JOIN shopping_lists sl ON li.list_id = sl.id
           JOIN store_prices sp ON li.barcode = sp.barcode
           WHERE sl.user_id = $1
             AND li.barcode IS NOT NULL
             AND li.barcode != ''
           GROUP BY li.barcode
           HAVING COUNT(DISTINCT sp.store_id) >= 2
         ) price_diffs) as total_saved`,
      [req.user.id]
    );

    const stats = statsResult.rows[0];

    // Get recent activity
    const activityResult = await query(
      `SELECT 'list' as type, sl.id, sl.name, sl.updated_at as timestamp,
        (SELECT COUNT(*) FROM list_items li WHERE li.list_id = sl.id) as item_count
       FROM shopping_lists sl
       WHERE sl.user_id = $1
       ORDER BY sl.updated_at DESC
       LIMIT 5`,
      [req.user.id]
    );

    const recentActivity = activityResult.rows.map(row => ({
      type: row.type,
      id: row.id,
      name: row.name,
      itemCount: parseInt(row.item_count),
      timestamp: row.timestamp,
    }));

    // Get deals
    const dealsResult = await query(
      `SELECT * FROM deals 
       WHERE is_active = true 
       AND (end_date IS NULL OR end_date >= NOW())
       ORDER BY created_at DESC
       LIMIT 6`
    );

    const deals = dealsResult.rows.map(deal => ({
      id: deal.id,
      title: deal.title,
      description: deal.description,
      discount: deal.discount,
      store: deal.store,
      imageUrl: deal.image_url,
      category: deal.category,
      endDate: deal.end_date,
    }));

    successResponse(res, {
      stats: {
        itemsThisMonth: parseInt(stats.items_this_month) || 0,
        totalSaved: parseFloat(stats.total_saved) || 0,
        tripsThisMonth: parseInt(stats.trips_this_month) || 0,
        timeSaved: `${Math.floor(parseInt(stats.items_this_month) * 0.5)} min`,
      },
      recentActivity,
      deals,
    });
  } catch (error) {
    console.error('Get dashboard error:', error);
    errorResponse(res, 500, 'Failed to fetch dashboard data');
  }
});

// ── GET /api/dashboard/stats ────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const { period = 'month' } = req.query;

    let dateFilter;
    switch (period) {
      case 'week':
        dateFilter = "date_trunc('week', NOW())";
        break;
      case 'year':
        dateFilter = "date_trunc('year', NOW())";
        break;
      default:
        dateFilter = "date_trunc('month', NOW())";
    }

    const result = await query(
      `SELECT 
        (SELECT COUNT(*) FROM list_items li
         JOIN shopping_lists sl ON li.list_id = sl.id
         WHERE sl.user_id = $1 
         AND li.created_at >= ${dateFilter}) as items_count,
        (SELECT COALESCE(SUM(total), 0) FROM shopping_trips
         WHERE user_id = $1 
         AND trip_date >= ${dateFilter}) as total_spent,
        (SELECT COUNT(*) FROM shopping_trips
         WHERE user_id = $1
         AND trip_date >= ${dateFilter}) as trips_count,
        (SELECT COUNT(*) FROM saved_recipes
         WHERE user_id = $1) as saved_recipes`,
      [req.user.id]
    );

    const stats = result.rows[0];

    successResponse(res, {
      stats: {
        itemsCount: parseInt(stats.items_count) || 0,
        totalSpent: parseFloat(stats.total_spent) || 0,
        tripsCount: parseInt(stats.trips_count) || 0,
        savedRecipes: parseInt(stats.saved_recipes) || 0,
        timeSaved: `${Math.floor(parseInt(stats.items_count) * 0.5)} min`,
      },
      period,
    });
  } catch (error) {
    console.error('Get stats error:', error);
    errorResponse(res, 500, 'Failed to fetch stats');
  }
});

// ── GET /api/dashboard/recent-activity ──────────────────────

router.get('/recent-activity', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    // Combine different activity types
    const listActivity = await query(
      `SELECT 'list_update' as type, sl.id, sl.name as title, 
        sl.updated_at as timestamp,
        'Updated shopping list' as description
       FROM shopping_lists sl
       WHERE sl.user_id = $1
       ORDER BY sl.updated_at DESC
       LIMIT $2`,
      [req.user.id, Math.ceil(parseInt(limit) / 2)]
    );

    const tripActivity = await query(
      `SELECT 'shopping_trip' as type, st.id, st.store_name as title,
        st.trip_date as timestamp,
        CONCAT('Spent $', st.total, ' on ', st.item_count, ' items') as description
       FROM shopping_trips st
       WHERE st.user_id = $1
       ORDER BY st.trip_date DESC
       LIMIT $2`,
      [req.user.id, Math.ceil(parseInt(limit) / 2)]
    );

    // Combine and sort by timestamp
    const allActivity = [
      ...listActivity.rows,
      ...tripActivity.rows,
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
     .slice(0, parseInt(limit));

    successResponse(res, { activity: allActivity });
  } catch (error) {
    console.error('Get recent activity error:', error);
    errorResponse(res, 500, 'Failed to fetch activity');
  }
});

// ── GET /api/dashboard/deals ────────────────────────────────

router.get('/deals', async (req, res) => {
  try {
    const { category, limit = 10 } = req.query;

    let queryText = `
      SELECT * FROM deals
      WHERE is_active = true
        AND (end_date IS NULL OR end_date >= NOW())
    `;
    const params = [];

    if (category) {
      params.push(category);
      queryText += ` AND category = $${params.length}`;
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await query(queryText, params);

    const deals = result.rows.map(deal => ({
      id: deal.id,
      title: deal.title,
      description: deal.description,
      discount: deal.discount,
      store: deal.store,
      imageUrl: deal.image_url,
      category: deal.category,
      startDate: deal.start_date,
      endDate: deal.end_date,
    }));

    successResponse(res, { deals });
  } catch (error) {
    console.error('Get deals error:', error);
    errorResponse(res, 500, 'Failed to fetch deals');
  }
});

// ── GET /api/notifications ──────────────────────────────────

router.get('/notifications', async (req, res) => {
  try {
    const { unreadOnly, limit = 20 } = req.query;

    let queryText = `
      SELECT * FROM notifications
      WHERE user_id = $1
    `;
    const params = [req.user.id];

    if (unreadOnly === 'true') {
      queryText += ' AND read = false';
    }

    queryText += ` ORDER BY created_at DESC LIMIT $2`;
    params.push(parseInt(limit));

    const result = await query(queryText, params);

    const notifications = result.rows.map(n => ({
      id: n.id,
      title: n.title,
      message: n.message,
      type: n.type,
      read: n.read,
      createdAt: n.created_at,
    }));

    // Get unread count
    const unreadResult = await query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = false',
      [req.user.id]
    );

    successResponse(res, {
      notifications,
      unreadCount: parseInt(unreadResult.rows[0].count),
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    errorResponse(res, 500, 'Failed to fetch notifications');
  }
});

// ── PATCH /api/notifications/:id/read ───────────────────────

router.patch('/notifications/:id/read', async (req, res) => {
  try {
    const result = await query(
      'UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Notification not found');
    }

    successResponse(res, { message: 'Notification marked as read' });
  } catch (error) {
    console.error('Mark notification read error:', error);
    errorResponse(res, 500, 'Failed to update notification');
  }
});

// ── POST /api/notifications/read-all ────────────────────────

router.post('/notifications/read-all', async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET read = true WHERE user_id = $1',
      [req.user.id]
    );

    successResponse(res, { message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Mark all read error:', error);
    errorResponse(res, 500, 'Failed to update notifications');
  }
});

module.exports = router;
