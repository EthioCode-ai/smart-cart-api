// src/routes/stores.js
// ============================================================
// Stores Routes — with Google Places API integration
// ============================================================
const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate, optionalAuth } = require('../middleware/auth');
const router = express.Router();

const GOOGLE_MAPS_KEY = process.env.G_MAPS;

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
  photoUrl: row.photo_reference && GOOGLE_MAPS_KEY
    ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${row.photo_reference}&key=${GOOGLE_MAPS_KEY}`
    : null,
  googlePlaceId: row.google_place_id,
  features: row.features || [],
  services: row.services || [],
  isOpen: row.is_open,
  isFavorite: isFavorite || row.is_favorite || false,
  favoriteNote: row.favorite_note,
});

// ── Helper: Format Google Places result ─────────────────────
const formatGooglePlace = (place) => ({
  id: `google_${place.place_id}`,
  name: place.name,
  address: place.vicinity || place.formatted_address || '',
  latitude: place.geometry?.location?.lat || 0,
  longitude: place.geometry?.location?.lng || 0,
  phone: null,
  hours: place.opening_hours?.weekday_text || null,
  rating: place.rating || 0,
  photoReference: place.photos?.[0]?.photo_reference || null,
  photoUrl: place.photos?.[0]?.photo_reference && GOOGLE_MAPS_KEY
    ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${place.photos[0].photo_reference}&key=${GOOGLE_MAPS_KEY}`
    : null,
  googlePlaceId: place.place_id,
  features: place.types || [],
  services: [],
  isOpen: place.opening_hours?.open_now ?? null,
  isFavorite: false,
  favoriteNote: null,
 distance: null, // Calculated server-side in fetchGooglePlaces
  totalRatings: place.user_ratings_total || 0,
  priceLevel: place.price_level ?? null,
});

// ── Helper: Haversine distance in km ──────────────────────────
const haversineKm = (lat1, lon1, lat2, lon2) => {
  const toRad = (deg) => deg * Math.PI / 180;
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ── Helper: Fetch from Google Places API ──────────────────────
// Always fetches fresh results. No type= filter so keyword catches
// supermarkets, grocery stores, discount grocers, ethnic markets, etc.
const fetchGooglePlaces = async (originLat, originLng, radiusMeters = 25000, keyword = 'grocery store supermarket') => {
  if (!GOOGLE_MAPS_KEY) {
    console.warn('G_MAPS env variable not set — cannot fetch Google Places');
    return [];
  }

  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json`
    + `?location=${originLat},${originLng}`
    + `&radius=${radiusMeters}`
    + `&keyword=${encodeURIComponent(keyword)}`
    + `&key=${GOOGLE_MAPS_KEY}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error('Google Places API error:', data.status, data.error_message);
      return [];
    }

    const results = data.results || [];

    // Calculate server-side distance and attach to each store
    const stores = results.map(place => {
      const store = formatGooglePlace(place);
      const distKm = haversineKm(originLat, originLng, store.latitude, store.longitude);
      store.distance = Math.round(distKm * 100) / 100;
      return store;
    });

    // Return sorted nearest-first
    stores.sort((a, b) => a.distance - b.distance);
    return stores;
  } catch (err) {
    console.error('Google Places fetch error:', err.message);
    return [];
  }
};

// ── Helper: Cache Google Places results in DB ───────────────
const cacheGoogleStores = async (stores) => {
  for (const store of stores) {
    try {
      await query(
        `INSERT INTO stores (name, address, latitude, longitude, rating, photo_reference, google_place_id, is_open, features)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (google_place_id) DO UPDATE SET
           rating = EXCLUDED.rating,
           is_open = EXCLUDED.is_open,
           updated_at = NOW()`,
        [
          store.name, store.address, store.latitude, store.longitude,
          store.rating, store.photoReference, store.googlePlaceId,
          store.isOpen, store.features || [],
        ]
      );
    } catch (err) {
      // Silently skip cache errors — not critical
      // Table might not have google_place_id unique constraint yet
    }
  }
};

// ── GET /api/stores/nearby ──────────────────────────────────
router.get('/nearby', optionalAuth, async (req, res) => {
  try {
    const { lat, lng, radius = 25 } = req.query;

    if (!lat || !lng) {
      return errorResponse(res, 400, 'Latitude and longitude are required');
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const radiusKm = parseFloat(radius);
    const radiusMeters = Math.min(radiusKm * 1000, 50000); // Google max 50km

    // Always fetch fresh from Google Places for real-time accuracy
    const googleStores = await fetchGooglePlaces(latitude, longitude, radiusMeters);

    if (googleStores.length > 0) {
      // Cache in background for offline fallback — don't block response
      cacheGoogleStores(googleStores).catch(() => {});
      return successResponse(res, { stores: googleStores, source: 'google_places' });
    }

    // Fallback: local DB only when Google returns nothing (no API key, network issue, etc.)
    console.warn('Google Places returned 0 results — falling back to local DB');
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

    successResponse(res, { stores, source: 'database' });
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

    // Try local DB first
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

    // If local results found, return them
    if (result.rows.length > 0) {
      return successResponse(res, { stores: result.rows.map(row => formatStore(row)) });
    }

    // Otherwise, search Google Places
    if (lat && lng && GOOGLE_MAPS_KEY) {
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q + ' grocery store')}&location=${lat},${lng}&radius=15000&key=${GOOGLE_MAPS_KEY}`;
      try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.status === 'OK') {
          const stores = (data.results || []).slice(0, limit).map(formatGooglePlace);
          return successResponse(res, { stores, source: 'google_places' });
        }
      } catch (err) {
        console.error('Google Places search error:', err.message);
      }
    }

    successResponse(res, { stores: [] });
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
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [req.params.id, req.user.id, videoUrl, JSON.stringify(layoutData)]
    );

    successResponse(res, {
      contribution: {
        id: result.rows[0].id,
        storeId: result.rows[0].store_id,
        status: result.rows[0].status,
        createdAt: result.rows[0].created_at,
      },
    }, 201);
  } catch (error) {
    console.error('Create contribution error:', error);
    errorResponse(res, 500, 'Failed to create contribution');
  }
});

// ── POST /api/stores/:id/favorite ───────────────────────────
router.post('/:id/favorite', authenticate, async (req, res) => {
  try {
    const { note } = req.body;
    await query(
      `INSERT INTO favorite_stores (user_id, store_id, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, store_id) DO UPDATE SET description = $3`,
      [req.user.id, req.params.id, note || null]
    );
    successResponse(res, { message: 'Store added to favorites' });
  } catch (error) {
    console.error('Add favorite error:', error);
    errorResponse(res, 500, 'Failed to add favorite');
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
    console.error('Remove favorite error:', error);
    errorResponse(res, 500, 'Failed to remove favorite');
  }
});

// ── GET /api/stores/:id/directions ──────────────────────────
router.get('/:id/directions', async (req, res) => {
  try {
    const { origin_lat, origin_lng, mode = 'driving' } = req.query;

    if (!origin_lat || !origin_lng) {
      return errorResponse(res, 400, 'Origin latitude and longitude are required');
    }

    // Get store location
    const result = await query(
      'SELECT latitude, longitude, address FROM stores WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Store not found');
    }

    const store = result.rows[0];

    if (!GOOGLE_MAPS_KEY) {
      // Return deep link for Google Maps app
      return successResponse(res, {
        directionsUrl: `https://www.google.com/maps/dir/?api=1&origin=${origin_lat},${origin_lng}&destination=${store.latitude},${store.longitude}&travelmode=${mode}`,
        distance: null,
        duration: null,
      });
    }

    // Fetch directions from Google Directions API
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin_lat},${origin_lng}&destination=${store.latitude},${store.longitude}&mode=${mode}&key=${GOOGLE_MAPS_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') {
      return successResponse(res, {
        directionsUrl: `https://www.google.com/maps/dir/?api=1&origin=${origin_lat},${origin_lng}&destination=${store.latitude},${store.longitude}&travelmode=${mode}`,
        distance: null,
        duration: null,
      });
    }

    const route = data.routes[0];
    const leg = route.legs[0];

    successResponse(res, {
      distance: leg.distance.text,
      duration: leg.duration.text,
      directionsUrl: `https://www.google.com/maps/dir/?api=1&origin=${origin_lat},${origin_lng}&destination=${store.latitude},${store.longitude}&travelmode=${mode}`,
      steps: leg.steps.map(step => ({
        instruction: step.html_instructions.replace(/<[^>]*>/g, ''),
        distance: step.distance.text,
        duration: step.duration.text,
      })),
      polyline: route.overview_polyline.points,
    });
  } catch (error) {
    console.error('Get directions error:', error);
    errorResponse(res, 500, 'Failed to fetch directions');
  }
});

// ── POST /api/stores/register ─────────────────────────────
// Register a Google Places store in the local DB (upsert by google_place_id)
// Returns the real PostgreSQL store ID for use with store-layouts endpoints

router.post('/register', optionalAuth, async (req, res) => {
  try {
    const { name, address, latitude, longitude, rating, photoReference, googlePlaceId, isOpen, features } = req.body;

    if (!googlePlaceId || !name) {
      return errorResponse(res, 400, 'Store name and Google Place ID are required');
    }

    const result = await query(
      `INSERT INTO stores (name, address, latitude, longitude, rating, photo_reference, google_place_id, is_open, features)
       VALUES ($1, $2, $3::FLOAT, $4::FLOAT, $5::FLOAT, $6, $7, $8::BOOLEAN, $9)
       ON CONFLICT (google_place_id) DO UPDATE SET
         name = EXCLUDED.name,
         address = EXCLUDED.address,
         latitude = $3::FLOAT,
         longitude = $4::FLOAT,
         rating = EXCLUDED.rating,
         photo_reference = EXCLUDED.photo_reference,
         is_open = EXCLUDED.is_open,
         updated_at = NOW()
       RETURNING id, name, address, latitude, longitude, rating, google_place_id`,
      [name, address, latitude, longitude, rating || 0, photoReference || null, googlePlaceId, isOpen || false, features || []]
    );

    const store = result.rows[0];

    successResponse(res, {
      store: {
        id: store.id,
        name: store.name,
        address: store.address,
        latitude: parseFloat(store.latitude),
        longitude: parseFloat(store.longitude),
        rating: parseFloat(store.rating) || 0,
        googlePlaceId: store.google_place_id,
      },
    });
  } catch (error) {
    console.error('Register store error:', error);
    errorResponse(res, 500, 'Failed to register store');
  }
});


module.exports = router;