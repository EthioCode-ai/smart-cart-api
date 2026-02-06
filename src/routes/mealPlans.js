// src/routes/mealPlans.js
// ============================================================
// Meal Plans Routes
// ============================================================

const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// ── Helper: Format meal plan response ───────────────────────

const formatMealPlan = (row, meals = []) => ({
  id: row.id,
  name: row.name,
  startDate: row.start_date,
  endDate: row.end_date,
  goal: row.goal,
  dailyCalories: row.daily_calories,
  isAIGenerated: row.is_ai_generated,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  meals: meals,
});

// ── GET /api/meal-plans ─────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT mp.*,
        (SELECT COUNT(*) FROM meal_plan_meals mpm WHERE mpm.plan_id = mp.id) as meal_count
       FROM meal_plans mp
       WHERE mp.user_id = $1
       ORDER BY mp.created_at DESC`,
      [req.user.id]
    );

    const plans = result.rows.map(row => ({
      ...formatMealPlan(row),
      mealCount: parseInt(row.meal_count),
    }));

    successResponse(res, { plans });
  } catch (error) {
    console.error('Get meal plans error:', error);
    errorResponse(res, 500, 'Failed to fetch meal plans');
  }
});

// ── POST /api/meal-plans ────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const { name, startDate, endDate, goal, dailyCalories, isAIGenerated = false } = req.body;

    if (!name) {
      return errorResponse(res, 400, 'Plan name is required');
    }

    const result = await query(
      `INSERT INTO meal_plans (user_id, name, start_date, end_date, goal, daily_calories, is_ai_generated)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, name, startDate, endDate, goal, dailyCalories || 2000, isAIGenerated]
    );

    successResponse(res, { plan: formatMealPlan(result.rows[0]) }, 201);
  } catch (error) {
    console.error('Create meal plan error:', error);
    errorResponse(res, 500, 'Failed to create meal plan');
  }
});

// ── GET /api/meal-plans/:id ─────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const planResult = await query(
      'SELECT * FROM meal_plans WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (planResult.rows.length === 0) {
      return errorResponse(res, 404, 'Meal plan not found');
    }

    // Get meals with recipe details
    const mealsResult = await query(
      `SELECT mpm.*, r.title as recipe_title, r.image_url, r.time, r.difficulty
       FROM meal_plan_meals mpm
       LEFT JOIN recipes r ON mpm.recipe_id = r.id
       WHERE mpm.plan_id = $1
       ORDER BY mpm.day_number, 
         CASE mpm.meal_type 
           WHEN 'breakfast' THEN 1 
           WHEN 'lunch' THEN 2 
           WHEN 'dinner' THEN 3 
           WHEN 'snack' THEN 4 
           ELSE 5 
         END`,
      [req.params.id]
    );

    const meals = mealsResult.rows.map(row => ({
      id: row.id,
      dayNumber: row.day_number,
      mealType: row.meal_type,
      recipeId: row.recipe_id,
      recipeTitle: row.recipe_title || row.recipe_name,
      recipeName: row.recipe_name,
      imageUrl: row.image_url,
      time: row.time,
      difficulty: row.difficulty,
      calories: row.calories,
    }));

    successResponse(res, { plan: formatMealPlan(planResult.rows[0], meals) });
  } catch (error) {
    console.error('Get meal plan error:', error);
    errorResponse(res, 500, 'Failed to fetch meal plan');
  }
});

// ── PUT /api/meal-plans/:id ─────────────────────────────────

router.put('/:id', async (req, res) => {
  try {
    const { name, startDate, endDate, goal, dailyCalories } = req.body;

    const result = await query(
      `UPDATE meal_plans SET
        name = COALESCE($1, name),
        start_date = COALESCE($2, start_date),
        end_date = COALESCE($3, end_date),
        goal = COALESCE($4, goal),
        daily_calories = COALESCE($5, daily_calories),
        updated_at = NOW()
       WHERE id = $6 AND user_id = $7
       RETURNING *`,
      [name, startDate, endDate, goal, dailyCalories, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Meal plan not found');
    }

    successResponse(res, { plan: formatMealPlan(result.rows[0]) });
  } catch (error) {
    console.error('Update meal plan error:', error);
    errorResponse(res, 500, 'Failed to update meal plan');
  }
});

// ── DELETE /api/meal-plans/:id ──────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM meal_plans WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Meal plan not found');
    }

    successResponse(res, { message: 'Meal plan deleted' });
  } catch (error) {
    console.error('Delete meal plan error:', error);
    errorResponse(res, 500, 'Failed to delete meal plan');
  }
});

// ── POST /api/meal-plans/:id/meals ──────────────────────────

router.post('/:id/meals', async (req, res) => {
  try {
    const { dayNumber, mealType, recipeId, recipeName, calories } = req.body;

    // Verify plan ownership
    const planCheck = await query(
      'SELECT id FROM meal_plans WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (planCheck.rows.length === 0) {
      return errorResponse(res, 404, 'Meal plan not found');
    }

    if (!dayNumber || !mealType) {
      return errorResponse(res, 400, 'Day number and meal type are required');
    }

    // Get recipe name if recipeId provided
    let finalRecipeName = recipeName;
    if (recipeId && !recipeName) {
      const recipeResult = await query(
        'SELECT title FROM recipes WHERE id = $1',
        [recipeId]
      );
      if (recipeResult.rows.length > 0) {
        finalRecipeName = recipeResult.rows[0].title;
      }
    }

    const result = await query(
      `INSERT INTO meal_plan_meals (plan_id, day_number, meal_type, recipe_id, recipe_name, calories)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.id, dayNumber, mealType, recipeId, finalRecipeName, calories]
    );

    // Update plan timestamp
    await query(
      'UPDATE meal_plans SET updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );

    const meal = result.rows[0];

    successResponse(res, {
      meal: {
        id: meal.id,
        dayNumber: meal.day_number,
        mealType: meal.meal_type,
        recipeId: meal.recipe_id,
        recipeName: meal.recipe_name,
        calories: meal.calories,
      },
    }, 201);
  } catch (error) {
    console.error('Add meal error:', error);
    errorResponse(res, 500, 'Failed to add meal');
  }
});

// ── DELETE /api/meal-plans/:id/meals/:mealId ────────────────

router.delete('/:id/meals/:mealId', async (req, res) => {
  try {
    // Verify plan ownership
    const planCheck = await query(
      'SELECT id FROM meal_plans WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (planCheck.rows.length === 0) {
      return errorResponse(res, 404, 'Meal plan not found');
    }

    const result = await query(
      'DELETE FROM meal_plan_meals WHERE id = $1 AND plan_id = $2 RETURNING id',
      [req.params.mealId, req.params.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Meal not found');
    }

    // Update plan timestamp
    await query(
      'UPDATE meal_plans SET updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );

    successResponse(res, { message: 'Meal removed' });
  } catch (error) {
    console.error('Delete meal error:', error);
    errorResponse(res, 500, 'Failed to remove meal');
  }
});

// ── GET /api/meal-plans/:id/nutrition ───────────────────────

router.get('/:id/nutrition', async (req, res) => {
  try {
    // Verify plan ownership
    const planCheck = await query(
      'SELECT daily_calories FROM meal_plans WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (planCheck.rows.length === 0) {
      return errorResponse(res, 404, 'Meal plan not found');
    }

    const targetCalories = planCheck.rows[0].daily_calories || 2000;

    // Get meals with calories
    const mealsResult = await query(
      `SELECT mpm.day_number, mpm.meal_type, mpm.calories, r.nutrition
       FROM meal_plan_meals mpm
       LEFT JOIN recipes r ON mpm.recipe_id = r.id
       WHERE mpm.plan_id = $1`,
      [req.params.id]
    );

    // Calculate daily totals
    const dailyTotals = {};
    mealsResult.rows.forEach(meal => {
      const day = meal.day_number;
      if (!dailyTotals[day]) {
        dailyTotals[day] = { calories: 0, protein: 0, carbs: 0, fat: 0 };
      }
      
      const calories = meal.calories || meal.nutrition?.calories || 0;
      dailyTotals[day].calories += calories;
      
      if (meal.nutrition) {
        dailyTotals[day].protein += meal.nutrition.protein || 0;
        dailyTotals[day].carbs += meal.nutrition.carbs || 0;
        dailyTotals[day].fat += meal.nutrition.fat || 0;
      }
    });

    successResponse(res, {
      targetCalories,
      dailyTotals,
      totalMeals: mealsResult.rows.length,
    });
  } catch (error) {
    console.error('Get nutrition error:', error);
    errorResponse(res, 500, 'Failed to fetch nutrition data');
  }
});

module.exports = router;
