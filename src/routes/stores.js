const express = require('express');
const { body, query, validationResult } = require('express-validator');
const db = require('../db');

const router = express.Router();

// Get nearby stores
router.get('/nearby', [
  query('latitude').isFloat({ min: -90, max: 90 }),
  query('longitude').isFloat({ min: -180, max: 180 }),
  query('radius').optional().isFloat({ min: 0.1, max: 100 }),
  query('limit').optional().isInt({ min: 1, max: 50 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { latitude, longitude, radius = 10, limit = 20 } = req.query;

    const result = await db.query(
      `SELECT 
        id, name, chain, 
        address_line1, address_line2, city, state, zip_code, country,
        latitude, longitude,
        phone, website, hours, features,
        store_size_sqft, parking_spaces, has_gas_station, has_pharmacy,
        has_optical, has_auto_center, num_checkout_lanes, num_self_checkout,
        is_mapped, mapping_coverage_percent, total_contributions,
        calculate_distance($1, $2, latitude, longitude) as distance_miles
      FROM stores
      WHERE is_active = true
      AND calculate_distance($1, $2, latitude, longitude) <= $3
      ORDER BY distance_miles
      LIMIT $4`,
      [latitude, longitude, radius, limit]
    );

    const stores = result.rows.map(store => ({
      id: store.id,
      name: store.name,
      chain: store.chain,
      address: {
        addressLine1: store.address_line1,
        addressLine2: store.address_line2,
        city: store.city,
        state: store.state,
        zipCode: store.zip_code,
        country: store.country
      },
      location: {
        latitude: parseFloat(store.latitude),
        longitude: parseFloat(store.longitude)
      },
      distanceMiles: parseFloat(store.distance_miles).toFixed(1),
      phone: store.phone,
      website: store.website,
      hours: store.hours,
      features: store.features || [],
      physicalAttributes: {
        storeSizeSqft: store.store_size_sqft,
        parkingSpaces: store.parking_spaces,
        hasGasStation: store.has_gas_station,
        hasPharmacy: store.has_pharmacy,
        hasOptical: store.has_optical,
        hasAutoCenter: store.has_auto_center,
        numCheckoutLanes: store.num_checkout_lanes,
        numSelfCheckout: store.num_self_checkout
      },
      isMapped: store.is_mapped,
      mappingCoveragePercent: store.mapping_coverage_percent,
      totalContributions: store.total_contributions
    }));

    res.json({ success: true, data: stores });
  } catch (error) {
    console.error('Get nearby stores error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stores' });
  }
});

// Search stores
router.get('/search', [
  query('q').trim().notEmpty()
], async (req, res) => {
  try {
    const { q, latitude, longitude } = req.query;

    let queryText = `
      SELECT 
        id, name, chain, 
        address_line1, city, state, zip_code,
        latitude, longitude,
        phone, features,
        is_mapped, mapping_coverage_percent
    `;

    const params = [`%${q}%`];

    if (latitude && longitude) {
      queryText += `, calculate_distance($2, $3, latitude, longitude) as distance_miles`;
      params.push(latitude, longitude);
    }

    queryText += `
      FROM stores
      WHERE is_active = true
      AND (
        name ILIKE $1 
        OR chain ILIKE $1 
        OR city ILIKE $1
        OR address_line1 ILIKE $1
      )
    `;

    if (latitude && longitude) {
      queryText += ` ORDER BY distance_miles`;
    } else {
      queryText += ` ORDER BY name`;
    }

    queryText += ` LIMIT 20`;

    const result = await db.query(queryText, params);

    const stores = result.rows.map(store => ({
      id: store.id,
      name: store.name,
      chain: store.chain,
      address: {
        addressLine1: store.address_line1,
        city: store.city,
        state: store.state,
        zipCode: store.zip_code
      },
      location: {
        latitude: parseFloat(store.latitude),
        longitude: parseFloat(store.longitude)
      },
      distanceMiles: store.distance_miles ? parseFloat(store.distance_miles).toFixed(1) : null,
      phone: store.phone,
      features: store.features || [],
      isMapped: store.is_mapped,
      mappingCoveragePercent: store.mapping_coverage_percent
    }));

    res.json({ success: true, data: stores });
  } catch (error) {
    console.error('Search stores error:', error);
    res.status(500).json({ success: false, error: 'Search failed' });
  }
});

// Get store by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `SELECT 
        id, name, chain, 
        address_line1, address_line2, city, state, zip_code, country,
        latitude, longitude,
        phone, website, hours, features,
        store_size_sqft, parking_spaces, has_gas_station, has_pharmacy,
        has_optical, has_auto_center, num_checkout_lanes, num_self_checkout,
        is_mapped, mapping_coverage_percent, total_contributions,
        created_at, updated_at
      FROM stores
      WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Store not found' });
    }

    const store = result.rows[0];

    res.json({
      success: true,
      data: {
        id: store.id,
        name: store.name,
        chain: store.chain,
        address: {
          addressLine1: store.address_line1,
          addressLine2: store.address_line2,
          city: store.city,
          state: store.state,
          zipCode: store.zip_code,
          country: store.country
        },
        location: {
          latitude: parseFloat(store.latitude),
          longitude: parseFloat(store.longitude)
        },
        phone: store.phone,
        website: store.website,
        hours: store.hours,
        features: store.features || [],
        physicalAttributes: {
          storeSizeSqft: store.store_size_sqft,
          parkingSpaces: store.parking_spaces,
          hasGasStation: store.has_gas_station,
          hasPharmacy: store.has_pharmacy,
          hasOptical: store.has_optical,
          hasAutoCenter: store.has_auto_center,
          numCheckoutLanes: store.num_checkout_lanes,
          numSelfCheckout: store.num_self_checkout
        },
        isMapped: store.is_mapped,
        mappingCoveragePercent: store.mapping_coverage_percent,
        totalContributions: store.total_contributions,
        createdAt: store.created_at,
        updatedAt: store.updated_at
      }
    });
  } catch (error) {
    console.error('Get store error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch store' });
  }
});

// Pin a new store
router.post('/pin', [
  body('name').trim().notEmpty(),
  body('address.addressLine1').trim().notEmpty(),
  body('address.city').trim().notEmpty(),
  body('address.state').trim().notEmpty(),
  body('address.zipCode').trim().notEmpty(),
  body('location.latitude').isFloat({ min: -90, max: 90 }),
  body('location.longitude').isFloat({ min: -180, max: 180 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, chain, address, location, phone, features, physicalAttributes } = req.body;

    // Check for duplicate (same location within ~50 meters)
    const duplicateCheck = await db.query(
      `SELECT id, name FROM stores 
       WHERE calculate_distance($1, $2, latitude, longitude) < 0.03
       AND is_active = true`,
      [location.latitude, location.longitude]
    );

    if (duplicateCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: `A store already exists at this location: ${duplicateCheck.rows[0].name}`
      });
    }

    const result = await db.query(
      `INSERT INTO stores (
        name, chain, 
        address_line1, address_line2, city, state, zip_code, country,
        latitude, longitude,
        phone, features,
        store_size_sqft, parking_spaces, has_gas_station, has_pharmacy,
        has_optical, has_auto_center, num_checkout_lanes, num_self_checkout
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING id, name, created_at`,
      [
        name,
        chain || null,
        address.addressLine1,
        address.addressLine2 || null,
        address.city,
        address.state,
        address.zipCode,
        address.country || 'USA',
        location.latitude,
        location.longitude,
        phone || null,
        features || [],
        physicalAttributes?.storeSizeSqft || null,
        physicalAttributes?.parkingSpaces || null,
        physicalAttributes?.hasGasStation || false,
        physicalAttributes?.hasPharmacy || false,
        physicalAttributes?.hasOptical || false,
        physicalAttributes?.hasAutoCenter || false,
        physicalAttributes?.numCheckoutLanes || null,
        physicalAttributes?.numSelfCheckout || null
      ]
    );

    const newStore = result.rows[0];

    res.status(201).json({
      success: true,
      data: {
        id: newStore.id,
        name: newStore.name,
        chain,
        address,
        location,
        phone,
        features: features || [],
        isMapped: false,
        mappingCoveragePercent: 0,
        createdAt: newStore.created_at
      },
      message: 'Store pinned successfully! You can now contribute its layout.'
    });
  } catch (error) {
    console.error('Pin store error:', error);
    res.status(500).json({ success: false, error: 'Failed to pin store' });
  }
});

// Update store attributes
router.patch('/:id/attributes', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      storeSizeSqft, parkingSpaces, hasGasStation, hasPharmacy,
      hasOptical, hasAutoCenter, numCheckoutLanes, numSelfCheckout
    } = req.body;

    const result = await db.query(
      `UPDATE stores SET
        store_size_sqft = COALESCE($2, store_size_sqft),
        parking_spaces = COALESCE($3, parking_spaces),
        has_gas_station = COALESCE($4, has_gas_station),
        has_pharmacy = COALESCE($5, has_pharmacy),
        has_optical = COALESCE($6, has_optical),
        has_auto_center = COALESCE($7, has_auto_center),
        num_checkout_lanes = COALESCE($8, num_checkout_lanes),
        num_self_checkout = COALESCE($9, num_self_checkout),
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, name`,
      [id, storeSizeSqft, parkingSpaces, hasGasStation, hasPharmacy,
       hasOptical, hasAutoCenter, numCheckoutLanes, numSelfCheckout]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Store not found' });
    }

    res.json({
      success: true,
      message: 'Store attributes updated',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Update store attributes error:', error);
    res.status(500).json({ success: false, error: 'Failed to update store' });
  }
});

module.exports = router;
