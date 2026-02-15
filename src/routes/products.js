// src/routes/products.js
// ============================================================
// Products Routes — barcode lookup via Open Food Facts API
// ============================================================
const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { optionalAuth } = require('../middleware/auth');
const router = express.Router();

// ── Category mapping from Open Food Facts tags ─────────────
const mapCategory = (categories) => {
  if (!categories) return 'grocery';
  const cat = categories.toLowerCase();
  if (cat.includes('dairy') || cat.includes('milk') || cat.includes('cheese') || cat.includes('yogurt')) return 'dairy';
  if (cat.includes('meat') || cat.includes('beef') || cat.includes('chicken') || cat.includes('pork') || cat.includes('poultry')) return 'meat';
  if (cat.includes('seafood') || cat.includes('fish') || cat.includes('shrimp')) return 'seafood';
  if (cat.includes('fruit') || cat.includes('vegetable') || cat.includes('produce') || cat.includes('salad')) return 'produce';
  if (cat.includes('bread') || cat.includes('baked') || cat.includes('bakery') || cat.includes('pastry')) return 'bakery';
  if (cat.includes('frozen')) return 'frozen';
  if (cat.includes('beverage') || cat.includes('drink') || cat.includes('juice') || cat.includes('soda') || cat.includes('water')) return 'beverages';
  if (cat.includes('snack') || cat.includes('chip') || cat.includes('cookie') || cat.includes('cracker')) return 'snacks';
  if (cat.includes('cereal') || cat.includes('breakfast')) return 'breakfast';
  if (cat.includes('sauce') || cat.includes('condiment') || cat.includes('spice') || cat.includes('seasoning')) return 'condiments';
  if (cat.includes('canned') || cat.includes('soup')) return 'canned';
  if (cat.includes('pasta') || cat.includes('rice') || cat.includes('grain') || cat.includes('noodle')) return 'pasta & grains';
  if (cat.includes('organic') || cat.includes('health') || cat.includes('natural')) return 'organic';
  if (cat.includes('baby')) return 'baby';
  if (cat.includes('pet')) return 'pet';
  if (cat.includes('clean') || cat.includes('paper') || cat.includes('household')) return 'household';
  return 'grocery';
};

// ── POST /api/products/lookup ───────────────────────────────
// Looks up a barcode using Open Food Facts (free, no API key needed)
router.post('/lookup', optionalAuth, async (req, res) => {
  try {
    const { barcode, type } = req.body;

    if (!barcode) {
      return errorResponse(res, 400, 'Barcode is required');
    }

    // Clean barcode — strip whitespace
    const cleanBarcode = barcode.trim();

    // ── Handle QR codes that contain URLs (e.g., Walmart, Target) ──
    const isUrl = cleanBarcode.startsWith('http') || cleanBarcode.includes('w-mt.co') || cleanBarcode.includes('wmt.co') || cleanBarcode.includes('walmart.com') || cleanBarcode.includes('target.com') || cleanBarcode.includes('samsclub.com') || cleanBarcode.includes('kroger.com');
    if (isUrl) {
      const fullUrl = cleanBarcode.startsWith('http') ? cleanBarcode : `https://${cleanBarcode}`;
      let productName = null;
      let productId = null;
      let brand = null;
      let productPrice = 0;
      let productImage = null;
      let source = 'qr_url';

      // Walmart shortened URLs: w-mt.co/q/... → follow redirect to get product ID
      if (fullUrl.includes('w-mt.co') || fullUrl.includes('wmt.co')) {
        try {
          const redirectRes = await fetch(fullUrl, { redirect: 'manual' });
          const redirectUrl = redirectRes.headers.get('location') || '';

          // Extract Walmart product ID from redirect URL
          const idMatch = redirectUrl.match(/\/ip\/[^/]*?\/(\d+)/);
          if (idMatch) {
            productId = idMatch[1];

            // Try UPCitemdb search by Walmart product ID
            try {
              const searchRes = await fetch(`https://api.upcitemdb.com/prod/trial/search?s=${productId}&type=product`);
              const searchData = await searchRes.json();
              if (searchData.items && searchData.items.length > 0) {
                const item = searchData.items[0];
                productName = item.title;
                brand = item.brand || null;
                productPrice = item.lowest_recorded_price || 0;
                productImage = (item.images && item.images.length > 0) ? item.images[0] : null;
                source = 'walmart_qr';
              }
            } catch (searchErr) {
              // UPCitemdb search failed
            }

            // If UPCitemdb didn't find it, use the URL slug as fallback
            if (!productName) {
              const slugMatch = redirectUrl.match(/\/ip\/([^/?]+)/);
              if (slugMatch && slugMatch[1].length > 3 && slugMatch[1] !== 'seort') {
                productName = slugMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
              } else {
                productName = `Walmart Product #${productId}`;
              }
              source = 'walmart_qr';
            }
          }
        } catch (redirErr) {
          console.error('Walmart QR error:', redirErr);
        }
      }

   
      // Walmart: https://www.walmart.com/ip/Great-Value-Whole-Milk-1-Gallon/123456789
      const walmartMatch = cleanBarcode.match(/walmart\.com\/ip\/([^/]+?)(?:\/(\d+))?(?:\?|$)/);
      if (walmartMatch) {
        const slug = walmartMatch[1];
        productId = walmartMatch[2] || slug;
        // Convert URL slug to readable name: "Great-Value-Whole-Milk" → "Great Value Whole Milk"
        productName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        source = 'walmart_qr';
      }

      // Target: https://www.target.com/p/product-name/-/A-12345678
      const targetMatch = cleanBarcode.match(/target\.com\/p\/([^/]+)\/-\/A-(\d+)/);
      if (targetMatch) {
        productName = targetMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        productId = targetMatch[2];
        source = 'target_qr';
      }

      // Sam's Club: https://www.samsclub.com/p/product-name/prod12345678
      const samsMatch = cleanBarcode.match(/samsclub\.com\/p\/([^/]+)\/(\w+)/);
      if (samsMatch) {
        productName = samsMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        productId = samsMatch[2];
        source = 'samsclub_qr';
      }

      // Kroger: https://www.kroger.com/p/product-name/0001234567890
      const krogerMatch = cleanBarcode.match(/kroger\.com\/p\/([^/]+)\/(\d+)/);
      if (krogerMatch) {
        productName = krogerMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        productId = krogerMatch[2];
        source = 'kroger_qr';
      }

      if (productName) {
        return successResponse(res, {
          product: {
            name: productName,
            brand: brand,
            category: 'grocery',
            price: productPrice,
            barcode: productId || cleanBarcode,
            imageUrl: productImage,
          },
          source,
        });
      }

      // Unknown URL — return what we can
      return successResponse(res, {
        product: null,
        message: 'Unrecognized QR code URL',
        url: cleanBarcode,
      });
    }

    // Check local cache first
    const cached = await query(
      'SELECT * FROM products WHERE barcode = $1',
      [cleanBarcode]
    );

    if (cached.rows.length > 0) {
      const row = cached.rows[0];
      return successResponse(res, {
        product: {
          name: row.name,
          brand: row.brand,
          category: row.category,
          price: parseFloat(row.price) || 0,
          barcode: row.barcode,
          imageUrl: row.image_url,
        },
        source: 'cache',
      });
    }

    // Query Open Food Facts API
    const url = `https://world.openfoodfacts.org/api/v2/product/${cleanBarcode}.json`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 1 || !data.product) {
      // Fallback: try UPCitemdb (free trial, 100 lookups/day)
      try {
        const upcRes = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${cleanBarcode}`);
        const upcData = await upcRes.json();

        if (upcData.code === 'OK' && upcData.items && upcData.items.length > 0) {
          const item = upcData.items[0];
          const upcProduct = {
            name: item.title || 'Unknown Product',
            brand: item.brand || null,
            category: mapCategory(item.category || ''),
            price: item.lowest_recorded_price || 0,
            barcode: cleanBarcode,
            imageUrl: (item.images && item.images.length > 0) ? item.images[0] : null,
          };

          // Cache in local DB
          query(
            `INSERT INTO products (barcode, name, brand, category, price, image_url)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (barcode) DO UPDATE SET
               name = EXCLUDED.name,
               brand = EXCLUDED.brand,
               category = EXCLUDED.category,
               price = EXCLUDED.price,
               image_url = EXCLUDED.image_url,
               updated_at = NOW()`,
            [cleanBarcode, upcProduct.name, upcProduct.brand, upcProduct.category, upcProduct.price, upcProduct.imageUrl]
          ).catch(() => {});

          return successResponse(res, { product: upcProduct, source: 'upcitemdb' });
        }
      } catch (upcErr) {
        console.error('UPCitemdb fallback error:', upcErr);
      }

      return successResponse(res, { product: null, message: 'Product not found' });
    }

    const p = data.product;
    const productName = p.product_name || p.product_name_en || 'Unknown Product';
    const brand = p.brands || null;
    const categories = p.categories || p.categories_tags?.join(', ') || '';
    const category = mapCategory(categories);
    const imageUrl = p.image_front_url || p.image_url || null;
    const quantity = p.quantity || null;

    const product = {
      name: brand ? `${brand} ${productName}` : productName,
      brand: brand,
      category: category,
      price: 0, // Open Food Facts doesn't have price data
      barcode: cleanBarcode,
      imageUrl: imageUrl,
      quantity: quantity,
      nutrition: {
        calories: p.nutriments?.['energy-kcal_100g'] || null,
        fat: p.nutriments?.fat_100g || null,
        carbs: p.nutriments?.carbohydrates_100g || null,
        protein: p.nutriments?.proteins_100g || null,
        sugar: p.nutriments?.sugars_100g || null,
        sodium: p.nutriments?.sodium_100g || null,
      },
    };

    // Supplement with UPCitemdb for price data
    if (!product.price || product.price === 0) {
      try {
        const upcRes = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${cleanBarcode}`);
        const upcData = await upcRes.json();
        if (upcData.code === 'OK' && upcData.items && upcData.items.length > 0) {
          const item = upcData.items[0];
          if (item.lowest_recorded_price) product.price = item.lowest_recorded_price;
          if (!product.imageUrl && item.images && item.images.length > 0) product.imageUrl = item.images[0];
        }
      } catch (upcErr) {
        // UPCitemdb supplement failed, continue without price
      }
    }

    // Cache in local DB (non-blocking)
    query(
      `INSERT INTO products (barcode, name, brand, category, price, image_url, nutrition)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (barcode) DO UPDATE SET
         name = EXCLUDED.name,
         brand = EXCLUDED.brand,
         category = EXCLUDED.category,
         price = COALESCE(NULLIF(EXCLUDED.price, 0), products.price),
         image_url = COALESCE(EXCLUDED.image_url, products.image_url),
         updated_at = NOW()`,
      [cleanBarcode, product.name, brand, category, product.price, product.imageUrl || imageUrl, JSON.stringify(product.nutrition)]
    ).catch(() => {}); // Don't fail if cache write fails

    successResponse(res, { product, source: 'open_food_facts' });
  } catch (error) {
    console.error('Product lookup error:', error);
    errorResponse(res, 500, 'Failed to look up product');
  }
});

// ── GET /api/products/search ────────────────────────────────
// Search Open Food Facts by name
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim().length < 2) {
      return successResponse(res, { products: [] });
    }

    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&json=1&page_size=${limit}`;
    const response = await fetch(url);
    const data = await response.json();

    const products = (data.products || []).map((p) => ({
      name: p.product_name || p.product_name_en || 'Unknown',
      brand: p.brands || null,
      category: mapCategory(p.categories || ''),
      barcode: p.code || null,
      imageUrl: p.image_front_small_url || null,
    }));

    successResponse(res, { products });
  } catch (error) {
    console.error('Product search error:', error);
    errorResponse(res, 500, 'Failed to search products');
  }
});

module.exports = router;