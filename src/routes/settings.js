// src/routes/settings.js
// ============================================================
// User Settings Routes
// ============================================================

const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// ── GET /api/settings ───────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    // Get or create user settings
    let settingsResult = await query(
      'SELECT * FROM user_settings WHERE user_id = $1',
      [req.user.id]
    );

    if (settingsResult.rows.length === 0) {
      // Create default settings
      await query(
        'INSERT INTO user_settings (user_id) VALUES ($1)',
        [req.user.id]
      );
      settingsResult = await query(
        'SELECT * FROM user_settings WHERE user_id = $1',
        [req.user.id]
      );
    }

    const settings = settingsResult.rows[0];

    // Get family members
    const familyResult = await query(
      'SELECT * FROM family_members WHERE user_id = $1 ORDER BY created_at',
      [req.user.id]
    );

    // Get favorite stores
    const favStoresResult = await query(
      `SELECT fs.*, s.name, s.address
       FROM favorite_stores fs
       JOIN stores s ON fs.store_id = s.id
       WHERE fs.user_id = $1
       ORDER BY fs.created_at DESC`,
      [req.user.id]
    );

    successResponse(res, {
      settings: {
        dietaryRestrictions: settings.dietary_restrictions || [],
        allergens: settings.allergens || [],
        createdAt: settings.created_at,
        updatedAt: settings.updated_at,
      },
      familyMembers: familyResult.rows.map(fm => ({
        id: fm.id,
        name: fm.name,
        relationship: fm.relationship,
        dietaryRestrictions: fm.dietary_restrictions || [],
        allergens: fm.allergens || [],
        createdAt: fm.created_at,
      })),
      favoriteStores: favStoresResult.rows.map(fs => ({
        id: fs.store_id,
        name: fs.name,
        address: fs.address,
        note: fs.description,
        addedAt: fs.created_at,
      })),
    });
  } catch (error) {
    console.error('Get settings error:', error);
    errorResponse(res, 500, 'Failed to fetch settings');
  }
});

// ── PUT /api/settings ───────────────────────────────────────

router.put('/', async (req, res) => {
  try {
    const { dietaryRestrictions, allergens } = req.body;

    const result = await query(
      `INSERT INTO user_settings (user_id, dietary_restrictions, allergens)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         dietary_restrictions = COALESCE($2, user_settings.dietary_restrictions),
         allergens = COALESCE($3, user_settings.allergens),
         updated_at = NOW()
       RETURNING *`,
      [req.user.id, dietaryRestrictions, allergens]
    );

    const settings = result.rows[0];

    successResponse(res, {
      settings: {
        dietaryRestrictions: settings.dietary_restrictions || [],
        allergens: settings.allergens || [],
        updatedAt: settings.updated_at,
      },
    });
  } catch (error) {
    console.error('Update settings error:', error);
    errorResponse(res, 500, 'Failed to update settings');
  }
});

// ── GET /api/settings/dietary ───────────────────────────────

router.get('/dietary', async (req, res) => {
  try {
    const result = await query(
      'SELECT dietary_restrictions FROM user_settings WHERE user_id = $1',
      [req.user.id]
    );

    successResponse(res, {
      dietaryRestrictions: result.rows[0]?.dietary_restrictions || [],
    });
  } catch (error) {
    console.error('Get dietary error:', error);
    errorResponse(res, 500, 'Failed to fetch dietary restrictions');
  }
});

// ── PUT /api/settings/dietary ───────────────────────────────

router.put('/dietary', async (req, res) => {
  try {
    const { dietaryRestrictions } = req.body;

    if (!Array.isArray(dietaryRestrictions)) {
      return errorResponse(res, 400, 'Dietary restrictions must be an array');
    }

    await query(
      `INSERT INTO user_settings (user_id, dietary_restrictions)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         dietary_restrictions = $2,
         updated_at = NOW()`,
      [req.user.id, dietaryRestrictions]
    );

    successResponse(res, { dietaryRestrictions });
  } catch (error) {
    console.error('Update dietary error:', error);
    errorResponse(res, 500, 'Failed to update dietary restrictions');
  }
});

// ── GET /api/settings/allergens ─────────────────────────────

router.get('/allergens', async (req, res) => {
  try {
    const result = await query(
      'SELECT allergens FROM user_settings WHERE user_id = $1',
      [req.user.id]
    );

    successResponse(res, {
      allergens: result.rows[0]?.allergens || [],
    });
  } catch (error) {
    console.error('Get allergens error:', error);
    errorResponse(res, 500, 'Failed to fetch allergens');
  }
});

// ── PUT /api/settings/allergens ─────────────────────────────

router.put('/allergens', async (req, res) => {
  try {
    const { allergens } = req.body;

    if (!Array.isArray(allergens)) {
      return errorResponse(res, 400, 'Allergens must be an array');
    }

    await query(
      `INSERT INTO user_settings (user_id, allergens)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         allergens = $2,
         updated_at = NOW()`,
      [req.user.id, allergens]
    );

    successResponse(res, { allergens });
  } catch (error) {
    console.error('Update allergens error:', error);
    errorResponse(res, 500, 'Failed to update allergens');
  }
});

// ── GET /api/settings/family ────────────────────────────────

router.get('/family', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM family_members WHERE user_id = $1 ORDER BY created_at',
      [req.user.id]
    );

    const familyMembers = result.rows.map(fm => ({
      id: fm.id,
      name: fm.name,
      relationship: fm.relationship,
      dietaryRestrictions: fm.dietary_restrictions || [],
      allergens: fm.allergens || [],
      createdAt: fm.created_at,
    }));

    successResponse(res, { familyMembers });
  } catch (error) {
    console.error('Get family error:', error);
    errorResponse(res, 500, 'Failed to fetch family members');
  }
});

// ── POST /api/settings/family ───────────────────────────────

router.post('/family', async (req, res) => {
  try {
    const { name, relationship, dietaryRestrictions, allergens } = req.body;

    if (!name || !name.trim()) {
      return errorResponse(res, 400, 'Name is required');
    }

    const result = await query(
      `INSERT INTO family_members (user_id, name, relationship, dietary_restrictions, allergens)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, name.trim(), relationship, dietaryRestrictions || [], allergens || []]
    );

    const fm = result.rows[0];

    successResponse(res, {
      familyMember: {
        id: fm.id,
        name: fm.name,
        relationship: fm.relationship,
        dietaryRestrictions: fm.dietary_restrictions || [],
        allergens: fm.allergens || [],
        createdAt: fm.created_at,
      },
    }, 201);
  } catch (error) {
    console.error('Add family member error:', error);
    errorResponse(res, 500, 'Failed to add family member');
  }
});

// ── PUT /api/settings/family/:id ────────────────────────────

router.put('/family/:id', async (req, res) => {
  try {
    const { name, relationship, dietaryRestrictions, allergens } = req.body;

    const result = await query(
      `UPDATE family_members SET
        name = COALESCE($1, name),
        relationship = COALESCE($2, relationship),
        dietary_restrictions = COALESCE($3, dietary_restrictions),
        allergens = COALESCE($4, allergens)
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [name, relationship, dietaryRestrictions, allergens, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Family member not found');
    }

    const fm = result.rows[0];

    successResponse(res, {
      familyMember: {
        id: fm.id,
        name: fm.name,
        relationship: fm.relationship,
        dietaryRestrictions: fm.dietary_restrictions || [],
        allergens: fm.allergens || [],
      },
    });
  } catch (error) {
    console.error('Update family member error:', error);
    errorResponse(res, 500, 'Failed to update family member');
  }
});

// ── DELETE /api/settings/family/:id ─────────────────────────

router.delete('/family/:id', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM family_members WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Family member not found');
    }

    successResponse(res, { message: 'Family member removed' });
  } catch (error) {
    console.error('Delete family member error:', error);
    errorResponse(res, 500, 'Failed to remove family member');
  }
});

// ── GET /api/settings/history ───────────────────────────────

router.get('/history', async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const result = await query(
      `SELECT st.*, s.address
       FROM shopping_trips st
       LEFT JOIN stores s ON st.store_id = s.id
       WHERE st.user_id = $1
       ORDER BY st.trip_date DESC
       LIMIT $2`,
      [req.user.id, parseInt(limit)]
    );

    const history = result.rows.map(trip => ({
      id: trip.id,
      storeId: trip.store_id,
      storeName: trip.store_name,
      storeAddress: trip.address,
      total: parseFloat(trip.total) || 0,
      itemCount: trip.item_count,
      note: trip.note,
      date: trip.trip_date,
    }));

    successResponse(res, { history });
  } catch (error) {
    console.error('Get history error:', error);
    errorResponse(res, 500, 'Failed to fetch shopping history');
  }
});

// ── POST /api/settings/history ──────────────────────────────

router.post('/history', async (req, res) => {
  try {
    const { storeId, storeName, total, itemCount, note } = req.body;

    if (!storeName) {
      return errorResponse(res, 400, 'Store name is required');
    }

    const result = await query(
      `INSERT INTO shopping_trips (user_id, store_id, store_name, total, item_count, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.user.id, storeId, storeName, total || 0, itemCount || 0, note]
    );

    const trip = result.rows[0];

    successResponse(res, {
      trip: {
        id: trip.id,
        storeName: trip.store_name,
        total: parseFloat(trip.total),
        itemCount: trip.item_count,
        note: trip.note,
        date: trip.trip_date,
      },
    }, 201);
  } catch (error) {
    console.error('Add history error:', error);
    errorResponse(res, 500, 'Failed to add shopping trip');
  }
});

module.exports = router;
