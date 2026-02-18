// src/routes/products.js
// ============================================================
// Products Routes — barcode lookup via Open Food Facts API
// ============================================================
const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { optionalAuth, authenticate } = require('../middleware/auth');
const router = express.Router();

// ── Cloudinary Setup ─────────────────────────────────────────
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadToCloudinary = async (base64Image, barcode) => {
  try {
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      console.warn('Cloudinary not configured — skipping image upload');
      return null;
    }
    const result = await cloudinary.uploader.upload(
      `data:image/jpeg;base64,${base64Image}`,
      {
        folder: 'smart-cart/products',
        public_id: `product_${barcode}_${Date.now()}`,
        transformation: [
          { width: 400, height: 400, crop: 'limit', quality: 'auto:good', format: 'webp' }
        ],
      }
    );
    return result.secure_url;
  } catch (err) {
    console.error('Cloudinary upload error:', err.message);
    return null;
  }
};

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

    // Check local cache first, supplement with store-specific crowdsourced prices
    const cached = await query(
      'SELECT * FROM products WHERE barcode = $1',
      [cleanBarcode]
    );

    // Get store-specific price (prefer same store, fallback to any store)
    const storeId = req.body.storeId || null;
    let storeSpecificPrice = null;
    try {
      if (storeId) {
        // First: exact store match
        const exactMatch = await query(
          'SELECT price, regular_price FROM store_prices WHERE barcode = $1 AND store_id = $2',
          [cleanBarcode, storeId]
        );
        if (exactMatch.rows.length > 0) {
          storeSpecificPrice = exactMatch.rows[0];
        }
      }
      // Fallback: most recent price from any store
      if (!storeSpecificPrice) {
        const anyStore = await query(
          'SELECT price, regular_price FROM store_prices WHERE barcode = $1 ORDER BY updated_at DESC LIMIT 1',
          [cleanBarcode]
        );
        if (anyStore.rows.length > 0) {
          storeSpecificPrice = anyStore.rows[0];
        }
      }
    } catch (spErr) {
      // store_prices check failed, continue
    }

    // Apply crowdsourced price to cached product
    if (cached.rows.length > 0 && storeSpecificPrice) {
      cached.rows[0].price = storeSpecificPrice.price;
    }

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
          ingredients: row.ingredients || null,
          allergens: row.allergens || [],
          dietaryTags: row.dietary_tags || [],
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

          // Save to store_prices if store context exists
          if (storeId && upcProduct.price > 0) {
            query(
              `INSERT INTO store_prices (store_id, barcode, price, source, scanned_by)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (store_id, barcode) DO UPDATE SET
                 price = CASE WHEN $3 <> store_prices.price THEN $3 ELSE store_prices.price END,
                 source = $4,
                 scanned_by = $5,
                 updated_at = NOW()`,
              [storeId, cleanBarcode, upcProduct.price, 'barcode_scan', req.user?.id || null]
            ).catch(() => {});
          }
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

    // ── Extract ingredients & allergens from Open Food Facts ──
    const ingredients = p.ingredients_text || p.ingredients_text_en || null;

    // Parse allergens from tags: ["en:milk", "en:gluten"] → ["dairy", "wheat"]
    const allergenMap = {
      'milk': 'dairy', 'lactose': 'dairy',
      'eggs': 'eggs', 'egg': 'eggs',
      'peanuts': 'peanuts', 'peanut': 'peanuts',
      'nuts': 'tree nuts', 'tree-nuts': 'tree nuts', 'almonds': 'tree nuts', 'cashews': 'tree nuts', 'walnuts': 'tree nuts', 'pecans': 'tree nuts',
      'wheat': 'wheat', 'gluten': 'wheat',
      'soybeans': 'soy', 'soy': 'soy', 'soya': 'soy',
      'fish': 'fish',
      'shellfish': 'shellfish', 'crustaceans': 'shellfish', 'shrimp': 'shellfish',
      'sesame': 'sesame', 'sesame-seeds': 'sesame',
    };
    const rawAllergens = [
      ...(p.allergens_tags || []),
      ...(p.traces_tags || []),
    ].map(tag => tag.replace('en:', '').toLowerCase());
    const allergens = [...new Set(
      rawAllergens.map(a => allergenMap[a] || null).filter(Boolean)
    )];

    // Parse dietary tags from labels: ["en:organic", "en:vegan"] → ["organic", "vegan"]
    const dietaryMap = {
      'organic': 'organic', 'vegan': 'vegan', 'vegetarian': 'vegetarian',
      'gluten-free': 'gluten-free', 'kosher': 'kosher', 'halal': 'halal',
      'sugar-free': 'sugar-free', 'no-sugar-added': 'sugar-free',
      'lactose-free': 'lactose-free', 'dairy-free': 'dairy-free',
      'keto': 'keto', 'paleo': 'paleo', 'low-sodium': 'low-sodium',
      'no-gluten': 'gluten-free', 'sans-gluten': 'gluten-free',
    };
    const rawLabels = (p.labels_tags || []).map(tag => tag.replace('en:', '').toLowerCase());
    const dietaryTags = [...new Set(
      rawLabels.map(l => dietaryMap[l] || null).filter(Boolean)
    )];

    const product = {
      name: brand ? `${brand} ${productName}` : productName,
      brand: brand,
      category: category,
      price: 0,
      barcode: cleanBarcode,
      imageUrl: imageUrl,
      quantity: quantity,
      ingredients: ingredients,
      allergens: allergens,
      dietaryTags: dietaryTags,
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
      `INSERT INTO products (barcode, name, brand, category, price, image_url, nutrition, ingredients, allergens, dietary_tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (barcode) DO UPDATE SET
         name = EXCLUDED.name,
         brand = EXCLUDED.brand,
         category = EXCLUDED.category,
         price = COALESCE(NULLIF(EXCLUDED.price, 0), products.price),
         image_url = COALESCE(EXCLUDED.image_url, products.image_url),
         ingredients = COALESCE(EXCLUDED.ingredients, products.ingredients),
         allergens = COALESCE(EXCLUDED.allergens, products.allergens),
         dietary_tags = COALESCE(EXCLUDED.dietary_tags, products.dietary_tags),
         updated_at = NOW()`,
      [cleanBarcode, product.name, brand, category, product.price, product.imageUrl || imageUrl, JSON.stringify(product.nutrition), ingredients, allergens.length > 0 ? allergens : null, dietaryTags.length > 0 ? dietaryTags : null]
    ).catch(() => {});

   // Apply crowdsourced store price if API didn't return one
    if ((!product.price || product.price === 0) && storeSpecificPrice) {
      product.price = parseFloat(storeSpecificPrice.price);
    }

    // Save to store_prices if we have a store context and any price
    if (storeId && product.price > 0) {
      query(
        `INSERT INTO store_prices (store_id, barcode, price, source, scanned_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (store_id, barcode) DO UPDATE SET
           price = CASE WHEN $3 <> store_prices.price THEN $3 ELSE store_prices.price END,
           source = $4,
           scanned_by = $5,
           updated_at = NOW()`,
        [storeId, cleanBarcode, product.price, 'barcode_scan', req.user?.id || null]
      ).catch(() => {});
    }

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

// ── POST /api/products/batch-price ─────────────────────────
// Batch save scanned products with prices from Walk & Scan
router.post('/batch-price', optionalAuth, async (req, res) => {
  try {
    const { storeId, aisleNumber, products } = req.body;

    if (!products || !Array.isArray(products) || products.length === 0) {
      return errorResponse(res, 400, 'Products array is required');
    }

    let saved = 0;
    let pricesUpdated = 0;

    for (const product of products) {
      const { barcode, name, price, regularPrice, source, imageUrl } = product;
      if (!barcode) continue;

      try {
        await query(
          `INSERT INTO products (barcode, name, brand, category, price, image_url)
           VALUES ($1, $2, NULL, 'grocery', $3, $4)
           ON CONFLICT (barcode) DO UPDATE SET
             name = COALESCE(NULLIF($2, ''), products.name),
             price = CASE WHEN $3 > 0 THEN $3 ELSE products.price END,
             image_url = COALESCE(NULLIF($4, ''), products.image_url),
             updated_at = NOW()`,
          [barcode, name || null, price || 0, imageUrl || null]
        );
        saved++;
        if (price > 0) pricesUpdated++;
      } catch (insertErr) {
        console.error(`Batch insert error for ${barcode}:`, insertErr.message);
      }

      if (storeId && price > 0) {
        try {
          await query(
            `INSERT INTO store_prices (store_id, barcode, price, regular_price, aisle_number, source, scanned_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (store_id, barcode) DO UPDATE SET
               price = $3,
               regular_price = COALESCE($4, store_prices.regular_price),
               aisle_number = COALESCE($5, store_prices.aisle_number),
               source = $6,
               scanned_by = $7,
               updated_at = NOW()`,
            [storeId, barcode, price, regularPrice || null, aisleNumber || null, source || 'walk_scan', req.user?.id || null]
          );
        } catch (priceErr) {
          if (priceErr.code !== '42P01') {
            console.error(`Store price insert error for ${barcode}:`, priceErr.message);
          }
        }
      }
    }

    successResponse(res, { saved, pricesUpdated, total: products.length });
  } catch (error) {
    console.error('Batch price error:', error);
    errorResponse(res, 500, 'Failed to save batch prices');
  }
});

// ── POST /api/products/upload-image ─────────────────────────
// Upload a product photo captured during Walk & Scan
router.post('/upload-image', optionalAuth, async (req, res) => {
  try {
    const { barcode, imageBase64 } = req.body;

    if (!barcode || !imageBase64) {
      return errorResponse(res, 400, 'Barcode and imageBase64 are required');
    }

    const imageUrl = await uploadToCloudinary(imageBase64, barcode);

    if (!imageUrl) {
      return errorResponse(res, 500, 'Image upload failed');
    }

    // Update products table with the new image
    await query(
      `UPDATE products SET image_url = $1, updated_at = NOW()
       WHERE barcode = $2 AND (image_url IS NULL OR image_url = '')`,
      [imageUrl, barcode]
    );

    successResponse(res, { imageUrl, barcode });
  } catch (error) {
    console.error('Upload image error:', error);
    errorResponse(res, 500, 'Failed to upload image');
  }
});

// ─── GPT-4o Vision OCR for Walk & Scan ───
router.post('/ocr-vision', authenticate, async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Read this grocery shelf price tag. Return ONLY valid JSON with no markdown:\n{"product_name": "...", "price": 0.00, "regular_price": null, "unit_price": null, "upc": null}\n\nRules:\n- price = the main shelf price customers pay (the large number)\n- regular_price = only if there is a separate higher regular/was/original price\n- unit_price = per oz/per lb/per fl oz price if shown\n- product_name = the product name on the tag\n- upc = barcode number if printed as digits on the tag (not QR codes)\n- All prices as numbers, not strings\n- If you cannot read a field, use null',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
                detail: 'low',
              },
            },
          ],
        }],
      }),
    });

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    res.json({
      product_name: parsed.product_name || null,
      price: parsed.price || null,
      regular_price: parsed.regular_price || null,
      unit_price: parsed.unit_price || null,
      upc: parsed.upc || null,
      source: 'gpt_vision',
    });
  } catch (err) {
    console.error('GPT Vision OCR error:', err.message);
    res.status(500).json({ error: 'Vision OCR failed' });
  }
});

module.exports = router;