const express = require('express');
const db = require('../db');

const router = express.Router();

// Get store layout (aisles and special areas)
router.get('/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params;

    // Get store info
    const storeResult = await db.query(
      `SELECT id, name, is_mapped, mapping_coverage_percent 
       FROM stores WHERE id = $1`,
      [storeId]
    );

    if (storeResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Store not found' });
    }

    // Get aisles
    const aislesResult = await db.query(
      `SELECT 
        id, aisle_number, aisle_description, categories,
        sequence_order, section, photo_url,
        is_verified, confidence_score
      FROM store_aisles
      WHERE store_id = $1
      ORDER BY sequence_order, aisle_number`,
      [storeId]
    );

    // Get special areas
    const areasResult = await db.query(
      `SELECT 
        id, area_type, area_name, sequence_order,
        is_entry_point, is_exit_point, photo_url,
        is_verified, confidence_score
      FROM store_special_areas
      WHERE store_id = $1
      ORDER BY sequence_order, area_type`,
      [storeId]
    );

    const store = storeResult.rows[0];

    res.json({
      success: true,
      data: {
        storeId: store.id,
        storeName: store.name,
        isMapped: store.is_mapped,
        mappingCoveragePercent: store.mapping_coverage_percent,
        totalAisles: aislesResult.rows.length,
        totalSpecialAreas: areasResult.rows.length,
        aisles: aislesResult.rows.map(aisle => ({
          id: aisle.id,
          aisleNumber: aisle.aisle_number,
          description: aisle.aisle_description,
          categories: aisle.categories || [],
          sequenceOrder: aisle.sequence_order,
          section: aisle.section,
          photoUrl: aisle.photo_url,
          isVerified: aisle.is_verified,
          confidenceScore: parseFloat(aisle.confidence_score)
        })),
        specialAreas: areasResult.rows.map(area => ({
          id: area.id,
          areaType: area.area_type,
          areaName: area.area_name,
          sequenceOrder: area.sequence_order,
          isEntryPoint: area.is_entry_point,
          isExitPoint: area.is_exit_point,
          photoUrl: area.photo_url,
          isVerified: area.is_verified,
          confidenceScore: parseFloat(area.confidence_score)
        }))
      }
    });
  } catch (error) {
    console.error('Get layout error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch layout' });
  }
});

// Get optimized shopping route
router.post('/:storeId/route', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { items } = req.body; // Array of { name, category, department }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Items array is required' });
    }

    // Get store aisles with categories
    const aislesResult = await db.query(
      `SELECT id, aisle_number, aisle_description, categories, sequence_order, section
       FROM store_aisles
       WHERE store_id = $1
       ORDER BY sequence_order`,
      [storeId]
    );

    const aisles = aislesResult.rows;

    // Simple category-to-aisle mapping
    const categoryAisleMap = {};
    aisles.forEach(aisle => {
      (aisle.categories || []).forEach(cat => {
        categoryAisleMap[cat.toLowerCase()] = aisle;
      });
    });

    // Department to category mapping (simplified)
    const departmentMap = {
      'produce': ['produce', 'fruits', 'vegetables', 'organic'],
      'dairy': ['dairy', 'milk', 'cheese', 'yogurt'],
      'meat': ['meat', 'poultry', 'seafood', 'deli'],
      'bakery': ['bakery', 'bread', 'pastries'],
      'frozen': ['frozen', 'ice cream'],
      'pantry': ['grocery', 'canned', 'pasta', 'snacks'],
      'beverages': ['beverages', 'drinks', 'soda', 'juice']
    };

    // Map items to aisles
    const routeItems = items.map((item, index) => {
      let matchedAisle = null;

      // Try to match by department
      if (item.department) {
        const categories = departmentMap[item.department.toLowerCase()] || [];
        for (const cat of categories) {
          if (categoryAisleMap[cat]) {
            matchedAisle = categoryAisleMap[cat];
            break;
          }
        }
      }

      // Try to match by category
      if (!matchedAisle && item.category) {
        matchedAisle = categoryAisleMap[item.category.toLowerCase()];
      }

      // Default to first aisle if no match
      if (!matchedAisle && aisles.length > 0) {
        matchedAisle = aisles[0];
      }

      return {
        item: item.name,
        originalIndex: index,
        aisle: matchedAisle ? {
          id: matchedAisle.id,
          aisleNumber: matchedAisle.aisle_number,
          description: matchedAisle.aisle_description,
          sequenceOrder: matchedAisle.sequence_order
        } : null,
        sequence: matchedAisle?.sequence_order || 999
      };
    });

    // Sort by aisle sequence for optimized route
    routeItems.sort((a, b) => a.sequence - b.sequence);

    // Add sequence numbers
    const route = routeItems.map((item, index) => ({
      ...item,
      sequence: index + 1
    }));

    // Estimate time (rough: 2 minutes per item + 30 seconds per aisle change)
    const uniqueAisles = new Set(route.filter(r => r.aisle).map(r => r.aisle.aisleNumber));
    const estimatedTime = (items.length * 2) + (uniqueAisles.size * 0.5);

    res.json({
      success: true,
      data: {
        route,
        estimatedTime: Math.round(estimatedTime),
        totalItems: items.length,
        aislesVisited: uniqueAisles.size
      }
    });
  } catch (error) {
    console.error('Get route error:', error);
    res.status(500).json({ success: false, error: 'Failed to calculate route' });
  }
});

// Get product locations in store
router.post('/:storeId/products/locate', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { products } = req.body; // Array of product names

    if (!products || !Array.isArray(products)) {
      return res.status(400).json({ success: false, error: 'Products array is required' });
    }

    const result = await db.query(
      `SELECT 
        pl.id, pl.product_name, pl.product_upc, pl.product_brand,
        pl.product_category, pl.shelf_level, pl.position_description,
        pl.price, pl.photo_url, pl.is_verified,
        sa.aisle_number, sa.aisle_description
      FROM product_locations pl
      LEFT JOIN store_aisles sa ON pl.aisle_id = sa.id
      WHERE pl.store_id = $1
      AND pl.product_name ILIKE ANY($2)`,
      [storeId, products.map(p => `%${p}%`)]
    );

    res.json({
      success: true,
      data: result.rows.map(row => ({
        id: row.id,
        productName: row.product_name,
        productUpc: row.product_upc,
        productBrand: row.product_brand,
        productCategory: row.product_category,
        shelfLevel: row.shelf_level,
        positionDescription: row.position_description,
        price: row.price ? parseFloat(row.price) : null,
        photoUrl: row.photo_url,
        isVerified: row.is_verified,
        aisle: {
          aisleNumber: row.aisle_number,
          description: row.aisle_description
        }
      }))
    });
  } catch (error) {
    console.error('Locate products error:', error);
    res.status(500).json({ success: false, error: 'Failed to locate products' });
  }
});

module.exports = router;
