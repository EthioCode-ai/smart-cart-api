// src/routes/stores.js
// ============================================================
// Stores Routes
// ============================================================

const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ── Helper: Format store response ───────────────────────────

const formatStore = (row, isFavorite = false) => ({
  id: row.id,
  name: row.name,
  address: row.address,
  latitude: parseFloat(row.latitude),
  longitude: parseFloat(row.longitude),
  phone: row.phone,
  hours: row.hours,
  rating: parseFloat(row.rating) || 0,
  photoReference: row.photo_reference,
  googlePlaceId: row.google_place_id,
  features: row.features || [],
  services: row.services || [],
  isOpen: row.is_open,
  isFavorite: isFavorite || row.is_favorite || false,
  favoriteNote: row.favorite_note,
});

// ── GET /api/stores/nearby ──────────────────────────────────

router.get('/nearby', optionalAuth, async (req, res) => {
  try {
    const { lat, lng, radius = 10 } = req.query;

    if (!lat || !lng) {
      return errorResponse(res, 400, 'Latitude and longitude are required');
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const radiusKm = parseFloat(radius);

    // Haversine formula for distance calculation
    // Haversine formula for distance calculation
    const result = await query(
      `SELECT *, 
        (6371 * acos(cos(radians($1)) * cos(radians(latitude)) *
         cos(radians(longitude) - radians($2)) +
         sin(radians($1)) * sin(radians(latitude)))) AS distance
       FROM stores
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL
         AND (6371 * acos(cos(radians($1)) * cos(radians(latitude)) *
              cos(radians(longitude) - radians($2)) +
              sin(radians($1)) * sin(radians(latitude)))) < $3
       ORDER BY distance
       LIMIT 50`,
      [latitude, longitude, radiusKm]
    );

    const stores = result.rows.map(row => ({
      ...formatStore(row),
      distance: Math.round(parseFloat(row.distance) * 100) / 100,
    }));

    successResponse(res, { stores });
  } catch (error) {
    console.error('Get nearby stores error:', error);
    errorResponse(res, 500, 'Failed to fetch nearby stores');
  }
});

// ── GET /api/stores/search ──────────────────────────────────

router.get('/search', optionalAuth, async (req, res) => {
  try {
    const { q, lat, lng, limit = 20 } = req.query;

    if (!q || q.trim().length < 2) {
      return successResponse(res, { stores: [] });
    }

    let queryText = `
      SELECT s.*,
        CASE WHEN fs.id IS NOT NULL THEN true ELSE false END as is_favorite,
        fs.description as favorite_note
      FROM stores s
      LEFT JOIN favorite_stores fs ON s.id = fs.store_id AND fs.user_id = $1
      WHERE s.name ILIKE $2 OR s.address ILIKE $2
    `;
    const params = [req.user?.id || null, `%${q}%`];

    if (lat && lng) {
      queryText += `
        ORDER BY (6371 * acos(cos(radians($3)) * cos(radians(latitude)) * 
                  cos(radians(longitude) - radians($4)) + 
                  sin(radians($3)) * sin(radians(latitude))))
      `;
      params.push(parseFloat(lat), parseFloat(lng));
    } else {
      queryText += ' ORDER BY s.rating DESC NULLS LAST';
    }

    queryText += ` LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await query(queryText, params);

    successResponse(res, { stores: result.rows.map(row => formatStore(row)) });
  } catch (error) {
    console.error('Search stores error:', error);
    errorResponse(res, 500, 'Failed to search stores');
  }
});

// ── GET /api/stores/favorites ───────────────────────────────

router.get('/favorites', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT s.*, true as is_favorite, fs.description as favorite_note
       FROM stores s
       JOIN favorite_stores fs ON s.id = fs.store_id
       WHERE fs.user_id = $1
       ORDER BY fs.created_at DESC`,
      [req.user.id]
    );

    successResponse(res, { stores: result.rows.map(row => formatStore(row, true)) });
  } catch (error) {
    console.error('Get favorite stores error:', error);
    errorResponse(res, 500, 'Failed to fetch favorite stores');
  }
});

// ── GET /api/stores/:id ─────────────────────────────────────

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT s.*,
        CASE WHEN fs.id IS NOT NULL THEN true ELSE false END as is_favorite,
        fs.description as favorite_note
       FROM stores s
       LEFT JOIN favorite_stores fs ON s.id = fs.store_id AND fs.user_id = $2
       WHERE s.id = $1`,
      [req.params.id, req.user?.id || null]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Store not found');
    }

    successResponse(res, { store: formatStore(result.rows[0]) });
  } catch (error) {
    console.error('Get store error:', error);
    errorResponse(res, 500, 'Failed to fetch store');
  }
});

// ── GET /api/stores/:id/features ────────────────────────────

router.get('/:id/features', async (req, res) => {
  try {
    const result = await query(
      'SELECT features, services FROM stores WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Store not found');
    }

    successResponse(res, {
      features: result.rows[0].features || [],
      services: result.rows[0].services || [],
    });
  } catch (error) {
    console.error('Get store features error:', error);
    errorResponse(res, 500, 'Failed to fetch store features');
  }
});

// ── GET /api/stores/:id/layout ──────────────────────────────

router.get('/:id/layout', async (req, res) => {
  try {
    const result = await query(
      `SELECT sl.* FROM store_layout sl
       WHERE sl.store_id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      // Return empty layout if none exists
      return successResponse(res, {
        layout: {
          aisles: [],
          sections: [],
          pointsOfInterest: [],
        },
      });
    }

    const layout = result.rows[0];

    successResponse(res, {
      layout: {
        aisles: layout.aisles || [],
        sections: layout.sections || [],
        pointsOfInterest: layout.points_of_interest || [],
        updatedAt: layout.updated_at,
      },
    });
  } catch (error) {
    console.error('Get store layout error:', error);
    errorResponse(res, 500, 'Failed to fetch store layout');
  }
});

// ── GET /api/stores/:id/contributions ───────────────────────

router.get('/:id/contributions', async (req, res) => {
  try {
    const result = await query(
      `SELECT sc.*, u.name as contributor_name
       FROM store_contributions sc
       JOIN users u ON sc.user_id = u.id
       WHERE sc.store_id = $1 AND sc.status = 'approved'
       ORDER BY sc.created_at DESC
       LIMIT 10`,
      [req.params.id]
    );

    const contributions = result.rows.map(row => ({
      id: row.id,
      videoUrl: row.video_url,
      layoutData: row.layout_data,
      status: row.status,
      contributorName: row.contributor_name,
      createdAt: row.created_at,
    }));

    successResponse(res, { contributions });
  } catch (error) {
    console.error('Get contributions error:', error);
    errorResponse(res, 500, 'Failed to fetch contributions');
  }
});

// ── POST /api/stores/:id/contributions ──────────────────────

router.post('/:id/contributions', authenticate, async (req, res) => {
  try {
    const { videoUrl, layoutData } = req.body;

    // Verify store exists
    const storeCheck = await query(
      'SELECT id FROM stores WHERE id = $1',
      [req.params.id]
    );

    if (storeCheck.rows.length === 0) {
      return errorResponse(res, 404, 'Store not found');
    }

    const result = await query(
      `INSERT INTO store_contributions (store_id, user_id, video_url, layout_data, status)
       VALUES ($1, $2, $3, $4, 'processing')
       RETURNING *`,
      [req.params.id, req.user.id, videoUrl, JSON.stringify(layoutData)]
    );

    successResponse(res, {
      contribution: {
        id: result.rows[0].id,
        status: result.rows[0].status,
        message: 'Contribution submitted for processing',
      },
    }, 201);
  } catch (error) {
    console.error('Submit contribution error:', error);
    errorResponse(res, 500, 'Failed to submit contribution');
  }
});

// ── POST /api/stores/:id/favorite ───────────────────────────

router.post('/:id/favorite', authenticate, async (req, res) => {
  try {
    const { description } = req.body;

    // Verify store exists
    const storeCheck = await query(
      'SELECT id FROM stores WHERE id = $1',
      [req.params.id]
    );

    if (storeCheck.rows.length === 0) {
      return errorResponse(res, 404, 'Store not found');
    }

    await query(
      `INSERT INTO favorite_stores (user_id, store_id, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, store_id) 
       DO UPDATE SET description = COALESCE($3, favorite_stores.description)`,
      [req.user.id, req.params.id, description]
    );

    successResponse(res, { message: 'Store added to favorites' });
  } catch (error) {
    console.error('Add favorite store error:', error);
    errorResponse(res, 500, 'Failed to add favorite store');
  }
});

// ── DELETE /api/stores/:id/favorite ─────────────────────────

router.delete('/:id/favorite', authenticate, async (req, res) => {
  try {
    await query(
      'DELETE FROM favorite_stores WHERE user_id = $1 AND store_id = $2',
      [req.user.id, req.params.id]
    );

    successResponse(res, { message: 'Store removed from favorites' });
  } catch (error) {
    console.error('Remove favorite store error:', error);
    errorResponse(res, 500, 'Failed to remove favorite store');
  }
});

module.exports = router;
