// src/routes/recipes.js
// ============================================================
// Recipes Routes
// ============================================================

const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ── Helper: Format recipe response ──────────────────────────

const formatRecipe = (row) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  category: row.category,
  difficulty: row.difficulty,
  time: row.time,
  servings: row.servings,
  rating: parseFloat(row.rating) || 0,
  imageUrl: row.image_url,
  ingredients: row.ingredients || [],
  instructions: row.instructions || [],
  nutrition: row.nutrition,
  isFeatured: row.is_featured,
  isAIGenerated: row.is_ai_generated,
  createdBy: row.created_by,
  createdAt: row.created_at,
  isSaved: row.is_saved || false,
});

// ── GET /api/recipes ────────────────────────────────────────

router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, search, limit = 50, offset = 0 } = req.query;

    let queryText = `
      SELECT r.*,
        CASE WHEN sr.id IS NOT NULL THEN true ELSE false END as is_saved
      FROM recipes r
      LEFT JOIN saved_recipes sr ON r.id = sr.recipe_id AND sr.user_id = $1
      WHERE 1=1
    `;
    const params = [req.user?.id || null];
    let paramCount = 1;

    if (category) {
      paramCount++;
      queryText += ` AND r.category = $${paramCount}`;
      params.push(category);
    }

    if (search) {
      paramCount++;
      queryText += ` AND (r.title ILIKE $${paramCount} OR r.description ILIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    queryText += ` ORDER BY r.rating DESC, r.created_at DESC`;
    queryText += ` LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(queryText, params);

    successResponse(res, {
      recipes: result.rows.map(formatRecipe),
      total: result.rowCount,
    });
  } catch (error) {
    console.error('Get recipes error:', error);
    errorResponse(res, 500, 'Failed to fetch recipes');
  }
});

// ── GET /api/recipes/featured ───────────────────────────────

router.get('/featured', optionalAuth, async (req, res) => {
  try {
    // Return up to 5 most recently saved/created recipes for this user
    const result = await query(
      `SELECT r.*,
        CASE WHEN sr.id IS NOT NULL THEN true ELSE false END as is_saved
       FROM recipes r
       LEFT JOIN saved_recipes sr ON r.id = sr.recipe_id AND sr.user_id = $1
       WHERE r.created_by = $1 OR sr.user_id = $1
       ORDER BY r.created_at DESC
       LIMIT 5`,
      [req.user?.id || null]
    );

    if (result.rows.length === 0) {
      // No user recipes — return highest rated as suggestions
      const fallback = await query(
        `SELECT r.*,
          CASE WHEN sr.id IS NOT NULL THEN true ELSE false END as is_saved
         FROM recipes r
         LEFT JOIN saved_recipes sr ON r.id = sr.recipe_id AND sr.user_id = $1
         ORDER BY r.rating DESC
         LIMIT 5`,
        [req.user?.id || null]
      );
      return successResponse(res, { recipes: fallback.rows.map(formatRecipe) });
    }

    successResponse(res, { recipes: result.rows.map(formatRecipe) });
  } catch (error) {
    console.error('Get featured recipes error:', error);
    errorResponse(res, 500, 'Failed to fetch featured recipes');
  }
});

// ── GET /api/recipes/search ─────────────────────────────────

router.get('/search', optionalAuth, async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;

    if (!q || q.trim().length < 2) {
      return successResponse(res, { recipes: [] });
    }

    const result = await query(
      `SELECT r.*,
        CASE WHEN sr.id IS NOT NULL THEN true ELSE false END as is_saved
       FROM recipes r
       LEFT JOIN saved_recipes sr ON r.id = sr.recipe_id AND sr.user_id = $1
       WHERE r.title ILIKE $2 
         OR r.description ILIKE $2
         OR r.ingredients::text ILIKE $2
       ORDER BY 
         CASE WHEN r.title ILIKE $3 THEN 0 ELSE 1 END,
         r.rating DESC
       LIMIT $4`,
      [req.user?.id || null, `%${q}%`, `${q}%`, parseInt(limit)]
    );

    successResponse(res, { recipes: result.rows.map(formatRecipe) });
  } catch (error) {
    console.error('Search recipes error:', error);
    errorResponse(res, 500, 'Failed to search recipes');
  }
});

// ── GET /api/recipes/my ─────────────────────────────────────

router.get('/my', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT r.*, true as is_saved
       FROM recipes r
       JOIN saved_recipes sr ON r.id = sr.recipe_id
       WHERE sr.user_id = $1
       ORDER BY sr.saved_at DESC`,
      [req.user.id]
    );

    successResponse(res, { recipes: result.rows.map(formatRecipe) });
  } catch (error) {
    console.error('Get my recipes error:', error);
    errorResponse(res, 500, 'Failed to fetch saved recipes');
  }
});

// ── GET /api/recipes/categories ─────────────────────────────

router.get('/categories', async (req, res) => {
  try {
    const result = await query(
      `SELECT category, COUNT(*) as count
       FROM recipes
       WHERE category IS NOT NULL
       GROUP BY category
       ORDER BY count DESC`
    );

    const categories = result.rows.map(row => ({
      name: row.category,
      count: parseInt(row.count),
    }));

    successResponse(res, { categories });
  } catch (error) {
    console.error('Get categories error:', error);
    errorResponse(res, 500, 'Failed to fetch categories');
  }
});

// ── GET /api/recipes/category/:category ─────────────────────

router.get('/category/:category', optionalAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT r.*,
        CASE WHEN sr.id IS NOT NULL THEN true ELSE false END as is_saved
       FROM recipes r
       LEFT JOIN saved_recipes sr ON r.id = sr.recipe_id AND sr.user_id = $1
       WHERE r.category = $2
       ORDER BY r.rating DESC, r.created_at DESC`,
      [req.user?.id || null, req.params.category]
    );

    successResponse(res, { recipes: result.rows.map(formatRecipe) });
  } catch (error) {
    console.error('Get category recipes error:', error);
    errorResponse(res, 500, 'Failed to fetch recipes');
  }
});

// ── GET /api/recipes/:id ────────────────────────────────────

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT r.*,
        CASE WHEN sr.id IS NOT NULL THEN true ELSE false END as is_saved
       FROM recipes r
       LEFT JOIN saved_recipes sr ON r.id = sr.recipe_id AND sr.user_id = $1
       WHERE r.id = $2`,
      [req.user?.id || null, req.params.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Recipe not found');
    }

    successResponse(res, { recipe: formatRecipe(result.rows[0]) });
  } catch (error) {
    console.error('Get recipe error:', error);
    errorResponse(res, 500, 'Failed to fetch recipe');
  }
});

// ── POST /api/recipes ───────────────────────────────────────

router.post('/', authenticate, async (req, res) => {
  try {
    const {
      title, description, category, difficulty, time, servings,
      imageUrl, ingredients, instructions, nutrition, isAIGenerated = false
    } = req.body;

    if (!title) {
      return errorResponse(res, 400, 'Recipe title is required');
    }

    const result = await query(
      `INSERT INTO recipes (
        title, description, category, difficulty, time, servings,
        image_url, ingredients, instructions, nutrition, 
        is_ai_generated, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        title, description, category, difficulty || 'Easy', time, 
        servings || 4, imageUrl, JSON.stringify(ingredients || []),
        JSON.stringify(instructions || []), JSON.stringify(nutrition),
        isAIGenerated, req.user.id
      ]
    );

    // Auto-save to user's recipes
    await query(
      'INSERT INTO saved_recipes (user_id, recipe_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, result.rows[0].id]
    );

    successResponse(res, { 
      recipe: formatRecipe({ ...result.rows[0], is_saved: true }) 
    }, 201);
  } catch (error) {
    console.error('Create recipe error:', error);
    errorResponse(res, 500, 'Failed to create recipe');
  }
});

// ── POST /api/recipes/:id/save ──────────────────────────────

router.post('/:id/save', authenticate, async (req, res) => {
  try {
    await query(
      'INSERT INTO saved_recipes (user_id, recipe_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, req.params.id]
    );

    successResponse(res, { message: 'Recipe saved' });
  } catch (error) {
    console.error('Save recipe error:', error);
    errorResponse(res, 500, 'Failed to save recipe');
  }
});

// ── DELETE /api/recipes/:id/save ────────────────────────────

router.delete('/:id/save', authenticate, async (req, res) => {
  try {
    await query(
      'DELETE FROM saved_recipes WHERE user_id = $1 AND recipe_id = $2',
      [req.user.id, req.params.id]
    );

    successResponse(res, { message: 'Recipe removed from saved' });
  } catch (error) {
    console.error('Unsave recipe error:', error);
    errorResponse(res, 500, 'Failed to remove recipe');
  }
});

// ── POST /api/recipes/:id/add-to-list ───────────────────────

router.post('/:id/add-to-list', authenticate, async (req, res) => {
  try {
    const { listId } = req.body;

    // Get recipe
    const recipeResult = await query(
      'SELECT * FROM recipes WHERE id = $1',
      [req.params.id]
    );

    if (recipeResult.rows.length === 0) {
      return errorResponse(res, 404, 'Recipe not found');
    }

    const recipe = recipeResult.rows[0];
    const ingredients = recipe.ingredients || [];

    // Verify list access
    const listCheck = await query(
      `SELECT sl.id FROM shopping_lists sl
       LEFT JOIN list_collaborators lc ON sl.id = lc.list_id AND lc.user_id = $2
       WHERE sl.id = $1 AND (sl.user_id = $2 OR lc.user_id = $2)`,
      [listId, req.user.id]
    );

    if (listCheck.rows.length === 0) {
      return errorResponse(res, 404, 'List not found');
    }

    // Add each ingredient to list
    let addedCount = 0;
    for (const ingredient of ingredients) {
      const name = typeof ingredient === 'string' ? ingredient : ingredient.name;
      const quantity = typeof ingredient === 'object' ? ingredient.quantity : 1;
      
      if (name) {
        await query(
          `INSERT INTO list_items (list_id, name, quantity, added_by)
           VALUES ($1, $2, $3, $4)`,
          [listId, name, quantity || 1, req.user.id]
        );
        addedCount++;
      }
    }

    // Update list timestamp
    await query(
      'UPDATE shopping_lists SET updated_at = NOW() WHERE id = $1',
      [listId]
    );

    successResponse(res, { 
      message: `Added ${addedCount} ingredients to list`,
      addedCount,
    });
  } catch (error) {
    console.error('Add to list error:', error);
    errorResponse(res, 500, 'Failed to add ingredients to list');
  }
});

module.exports = router;
