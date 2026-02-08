// src/routes/ai.js
// ============================================================
// AI Routes (OpenAI Integration)
// ============================================================

const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// OpenAI client setup
let openai = null;
try {
  const OpenAI = require('openai');
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
} catch (error) {
  console.warn('OpenAI not configured. AI features will return mock data.');
}

// Default fallback image when DALL-E fails
const DEFAULT_RECIPE_IMAGE = 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&h=400&fit=crop';

// ── Helper: Generate recipe image with DALL-E ───────────────

const generateRecipeImage = async (recipeTitle, recipeDescription) => {
  if (!openai || !recipeTitle) return DEFAULT_RECIPE_IMAGE;
  try {
    const prompt = `A professional, appetizing food photography shot of ${recipeTitle}. ${recipeDescription || ''}. High quality, well-lit, restaurant-style plating, garnished beautifully, overhead view, vibrant colors, depth of field.`;

    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
    });
    return response.data[0]?.url || DEFAULT_RECIPE_IMAGE;
  } catch (error) {
    console.error('DALL-E image generation error:', error.message);
    return DEFAULT_RECIPE_IMAGE;
  }
};

// ── Helper: Get user context for AI ─────────────────────────

const getUserContext = async (userId) => {
  try {
    const settingsResult = await query(
      'SELECT dietary_restrictions, allergens FROM user_settings WHERE user_id = $1',
      [userId]
    );

    const settings = settingsResult.rows[0] || {};

    return {
      dietaryRestrictions: settings.dietary_restrictions || [],
      allergens: settings.allergens || [],
    };
  } catch (error) {
    return { dietaryRestrictions: [], allergens: [] };
  }
};

// ── POST /api/ai/chat ───────────────────────────────────────

router.post('/chat', async (req, res) => {
  try {
    const { message, conversationHistory = [] } = req.body;

    if (!message) {
      return errorResponse(res, 400, 'Message is required');
    }

    const context = await getUserContext(req.user.id);

    if (!openai) {
      return successResponse(res, {
        response: `I'd be happy to help you with "${message}". As your shopping assistant, I can help you create lists, find recipes, and plan your meals. What would you like to do?`,
        suggestions: ['Create a shopping list', 'Find a recipe', 'Plan my meals'],
      });
    }

    const systemPrompt = `You are Smart Cart, a helpful AI shopping assistant.
You help users with grocery shopping, meal planning, and recipe suggestions.

User's dietary restrictions: ${context.dietaryRestrictions.join(', ') || 'None'}
User's allergens: ${context.allergens.join(', ') || 'None'}

Be concise, friendly, and helpful. Always consider the user's dietary needs.
When suggesting products, be specific with quantities.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map(h => ({
        role: h.role,
        content: h.content,
      })),
      { role: 'user', content: message },
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      max_tokens: 500,
      temperature: 0.7,
    });

    const response = completion.choices[0].message.content;

    successResponse(res, {
      response,
      suggestions: [],
    });
  } catch (error) {
    console.error('AI chat error:', error);
    errorResponse(res, 500, 'Failed to process message');
  }
});

// ── POST /api/ai/generate-recipe ────────────────────────────

router.post('/generate-recipe', async (req, res) => {
  try {
    const { ingredients, cuisine, servings = 4, mealType } = req.body;

    const context = await getUserContext(req.user.id);

    if (!openai) {
      return successResponse(res, {
        recipe: {
          title: 'Quick Pasta Primavera',
          description: 'A colorful and nutritious pasta dish loaded with fresh vegetables.',
          category: mealType || 'Dinner',
          difficulty: 'Easy',
          time: '25 min',
          servings,
          ingredients: [
            { name: 'Pasta', quantity: '1', unit: 'lb' },
            { name: 'Bell peppers', quantity: '2', unit: 'medium' },
            { name: 'Zucchini', quantity: '1', unit: 'medium' },
            { name: 'Cherry tomatoes', quantity: '1', unit: 'cup' },
            { name: 'Olive oil', quantity: '3', unit: 'tbsp' },
            { name: 'Garlic', quantity: '3', unit: 'cloves' },
            { name: 'Parmesan cheese', quantity: '1/2', unit: 'cup' },
          ],
          instructions: [
            { step: 1, text: 'Cook pasta according to package directions.' },
            { step: 2, text: 'Sauté garlic and vegetables in olive oil for 5 minutes.' },
            { step: 3, text: 'Toss pasta with vegetables and top with parmesan.' },
          ],
          nutrition: { calories: 450, protein: 15, carbs: 65, fat: 14 },
          imageUrl: DEFAULT_RECIPE_IMAGE,
          isAIGenerated: true,
        },
      });
    }

    const prompt = `Generate a recipe with the following requirements:
${ingredients ? `- Include these ingredients: ${ingredients.join(', ')}` : ''}
${cuisine ? `- Cuisine style: ${cuisine}` : ''}
- Servings: ${servings}
${mealType ? `- Meal type: ${mealType}` : ''}
${context.dietaryRestrictions.length ? `- Dietary restrictions: ${context.dietaryRestrictions.join(', ')}` : ''}
${context.allergens.length ? `- Avoid allergens: ${context.allergens.join(', ')}` : ''}

Respond in JSON format only:
{
  "title": "Recipe Name",
  "description": "Brief description",
  "category": "Breakfast|Lunch|Dinner|Desserts",
  "difficulty": "Easy|Medium|Hard",
  "time": "X min",
  "servings": ${servings},
  "ingredients": [{"name": "ingredient", "quantity": "1", "unit": "cup"}],
  "instructions": [{"step": 1, "text": "instruction"}],
  "nutrition": {"calories": 350, "protein": 20, "carbs": 45, "fat": 12}
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are an expert chef and culinary advisor. Generate detailed, accurate recipes with precise ingredient quantities and clear step-by-step instructions.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1000,
    });

    const recipe = JSON.parse(completion.choices[0].message.content);
    recipe.isAIGenerated = true;
    recipe.imageUrl = await generateRecipeImage(recipe.title, recipe.description);

    successResponse(res, { recipe });
  } catch (error) {
    console.error('Generate recipe error:', error);
    errorResponse(res, 500, 'Failed to generate recipe');
  }
});

// ── POST /api/ai/generate-meal-plan ─────────────────────────

router.post('/generate-meal-plan', async (req, res) => {
  try {
    const { goal, dailyCalories = 2000, dietType, days = 7 } = req.body;

    const context = await getUserContext(req.user.id);

    if (!openai) {
      const mockMeals = [];
      const mealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
      const sampleMeals = {
        breakfast: ['Oatmeal with Berries', 'Greek Yogurt Parfait', 'Avocado Toast', 'Smoothie Bowl'],
        lunch: ['Grilled Chicken Salad', 'Quinoa Bowl', 'Turkey Wrap', 'Vegetable Soup'],
        dinner: ['Baked Salmon', 'Pasta Primavera', 'Grilled Chicken', 'Stir-Fry'],
        snack: ['Apple with Almond Butter', 'Trail Mix', 'Hummus with Veggies', 'Protein Bar'],
      };

      for (let day = 1; day <= days; day++) {
        mealTypes.forEach(type => {
          const options = sampleMeals[type];
          mockMeals.push({
            dayNumber: day,
            mealType: type,
            recipeName: options[Math.floor(Math.random() * options.length)],
            calories: type === 'snack' ? 150 : Math.floor(dailyCalories / 3.5),
          });
        });
      }

      return successResponse(res, {
        meals: mockMeals,
        summary: { goal, dailyCalories, dietType, days },
      });
    }

    const prompt = `Generate a ${days}-day meal plan with:
- Goal: ${goal || 'General health'}
- Daily calories: ${dailyCalories}
- Diet type: ${dietType || 'Balanced'}
${context.dietaryRestrictions.length ? `- Dietary restrictions: ${context.dietaryRestrictions.join(', ')}` : ''}
${context.allergens.length ? `- Avoid allergens: ${context.allergens.join(', ')}` : ''}

For each day, include breakfast, lunch, dinner, and one snack.

Respond in JSON format only:
{
  "meals": [
    {"dayNumber": 1, "mealType": "breakfast", "recipeName": "Meal Name", "calories": 400},
    {"dayNumber": 1, "mealType": "lunch", "recipeName": "Meal Name", "calories": 500}
  ]
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are an expert nutritionist and meal planner. Generate balanced, varied meal plans that meet the specified nutritional goals.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000,
    });

    const result = JSON.parse(completion.choices[0].message.content);

    successResponse(res, {
      meals: result.meals,
      summary: { goal, dailyCalories, dietType, days },
    });
  } catch (error) {
    console.error('Generate meal plan error:', error);
    errorResponse(res, 500, 'Failed to generate meal plan');
  }
});

// ── POST /api/ai/recommendations ────────────────────────────

router.post('/recommendations', async (req, res) => {
  try {
    const { listId } = req.body;

    const context = await getUserContext(req.user.id);

    let currentItems = [];
    if (listId) {
      const itemsResult = await query(
        'SELECT name FROM list_items WHERE list_id = $1',
        [listId]
      );
      currentItems = itemsResult.rows.map(r => r.name);
    }

    if (!openai) {
      return successResponse(res, {
        recommendations: [
          { name: 'Milk', reason: 'Essential dairy staple', department: 'Dairy' },
          { name: 'Eggs', reason: 'Versatile protein source', department: 'Dairy' },
          { name: 'Bread', reason: 'Breakfast essential', department: 'Bakery' },
          { name: 'Bananas', reason: 'Healthy snack option', department: 'Produce' },
          { name: 'Chicken breast', reason: 'Lean protein', department: 'Meat' },
        ],
      });
    }

    const prompt = `Based on a shopping list containing: ${currentItems.join(', ') || 'nothing yet'}

Suggest 5 grocery items the user might need.
Consider dietary restrictions: ${context.dietaryRestrictions.join(', ') || 'None'}
Avoid allergens: ${context.allergens.join(', ') || 'None'}

Respond in JSON:
{
  "recommendations": [
    {"name": "Item", "reason": "Why suggested", "department": "Store department"}
  ]
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 500,
    });

    const result = JSON.parse(completion.choices[0].message.content);

    successResponse(res, { recommendations: result.recommendations });
  } catch (error) {
    console.error('Get recommendations error:', error);
    errorResponse(res, 500, 'Failed to get recommendations');
  }
});

// ── POST /api/ai/complementary-items ────────────────────────

router.post('/complementary-items', async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || items.length === 0) {
      return successResponse(res, { suggestions: [] });
    }

    if (!openai) {
      const mockSuggestions = {
        'pasta': ['marinara sauce', 'parmesan cheese', 'garlic bread'],
        'bread': ['butter', 'jam', 'peanut butter'],
        'chicken': ['rice', 'vegetables', 'olive oil'],
        'eggs': ['bacon', 'cheese', 'bread'],
      };

      let suggestions = [];
      items.forEach(item => {
        const key = Object.keys(mockSuggestions).find(k =>
          item.toLowerCase().includes(k)
        );
        if (key) {
          suggestions.push(...mockSuggestions[key]);
        }
      });

      return successResponse(res, {
        suggestions: [...new Set(suggestions)].slice(0, 5),
      });
    }

    const prompt = `Given these grocery items: ${items.join(', ')}

Suggest 5 complementary items that would pair well or complete a meal.

Respond in JSON: {"suggestions": ["item1", "item2", ...]}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 200,
    });

    const result = JSON.parse(completion.choices[0].message.content);

    successResponse(res, { suggestions: result.suggestions });
  } catch (error) {
    console.error('Complementary items error:', error);
    errorResponse(res, 500, 'Failed to get suggestions');
  }
});

// ── POST /api/ai/optimize-route ─────────────────────────────

router.post('/optimize-route', async (req, res) => {
  try {
    const { storeId, items } = req.body;

    if (!items || items.length === 0) {
      return successResponse(res, { optimizedRoute: [] });
    }

    let storeLayout = null;
    if (storeId) {
      const layoutResult = await query(
        'SELECT aisles, sections FROM store_layout WHERE store_id = $1',
        [storeId]
      );
      if (layoutResult.rows.length > 0) {
        storeLayout = layoutResult.rows[0];
      }
    }

    const departmentOrder = [
      'Produce', 'Bakery', 'Deli', 'Meat', 'Seafood',
      'Dairy', 'Frozen', 'Canned Goods', 'Snacks', 'Beverages',
      'Household', 'Personal Care', 'Other'
    ];

    const optimizedItems = [...items].sort((a, b) => {
      const deptA = departmentOrder.indexOf(a.department || 'Other');
      const deptB = departmentOrder.indexOf(b.department || 'Other');
      return (deptA === -1 ? 999 : deptA) - (deptB === -1 ? 999 : deptB);
    });

    successResponse(res, {
      optimizedRoute: optimizedItems,
      estimatedTime: `${Math.ceil(items.length * 1.5)} minutes`,
    });
  } catch (error) {
    console.error('Optimize route error:', error);
    errorResponse(res, 500, 'Failed to optimize route');
  }
});

// ── POST /api/ai/recognize-image ────────────────────────────

router.post('/recognize-image', async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return errorResponse(res, 400, 'Image data is required');
    }

    if (!openai) {
      return successResponse(res, {
        products: [
          { name: 'Apple', confidence: 0.95, department: 'Produce' },
          { name: 'Banana', confidence: 0.88, department: 'Produce' },
        ],
      });
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Identify the grocery products in this image. Respond in JSON: {"products": [{"name": "Product", "confidence": 0.95, "department": "Store department"}]}'
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
            }
          ],
        },
      ],
      max_tokens: 500,
    });

    const result = JSON.parse(response.choices[0].message.content);

    successResponse(res, { products: result.products });
  } catch (error) {
    console.error('Image recognition error:', error);
    errorResponse(res, 500, 'Failed to recognize image');
  }
});

// ── POST /api/ai/generate-list ──────────────────────────────

router.post('/generate-list', async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return errorResponse(res, 400, 'Prompt is required');
    }

    if (!openai) {
      return errorResponse(res, 503, 'AI service is temporarily unavailable. Please try again later.');
    }

    // ── Mode Detection ──
    const lower = prompt.toLowerCase();
    const recipeKeywords = ['recipe', 'cook', 'make', 'prepare', 'dish', 'meal', 'ingredients', 'ingredient'];
    const fullCourseKeywords = ['full course', 'full-course', 'complete dinner', 'complete meal', 'multi course', 'multi-course', 'appetizer and', 'three course', '3 course'];

    const isFullCourse = fullCourseKeywords.some(kw => lower.includes(kw));
    const isRecipeRequest = !isFullCourse && recipeKeywords.some(kw => lower.includes(kw));

    let systemPrompt;
    let userMessage = prompt;

    if (isFullCourse) {
      // ── Mode 3: Full-Course Meal ──
      systemPrompt = `You are an expert chef and meal planner. When asked for a full-course meal, provide a complete dining experience with multiple courses (appetizer, main course, side dishes, dessert, and optional beverage). Each course should be a distinct dish with its own ingredients list.

Respond with JSON: { "suggestions": [{"item": "item name", "category": "produce|meat|dairy|pantry|bakery|frozen|beverages|seafood|deli|household", "reason": "why needed", "price": 0.00}], "courses": [{"courseType": "appetizer|main|side|dessert", "dishName": "Name", "description": "Brief desc", "ingredients": [{"item": "name", "quantity": "1", "unit": "lb", "category": "meat"}], "prepTime": 30, "difficulty": "Easy|Medium|Hard"}], "mealTheme": "Theme name", "servings": 4, "message": "Friendly summary" }`;

    } else if (isRecipeRequest) {
      // ── Mode 2: Shopping List + Recipes ──
      systemPrompt = `You are a helpful shopping assistant and culinary expert. Generate shopping list items based on user requests AND provide recipe suggestions when appropriate. Categorize items (produce, dairy, meat, pantry, etc.) and provide brief reasons. When recipes are requested or appropriate, include detailed recipes with full instructions. Respond with JSON: { "suggestions": [{"item": "item name", "category": "category", "reason": "brief reason", "price": 0.00}], "recipes": [{"title": "Recipe Name", "description": "Brief description", "ingredients": [{"item": "ground beef", "quantity": "2", "unit": "lbs", "category": "meat"}], "instructions": ["Step 1...", "Step 2..."], "prepTime": 25, "servings": 4, "difficulty": "Easy|Medium|Hard", "tags": ["dinner", "cuisine"]}], "message": "helpful message" }`;

      userMessage = prompt + '. Please include recipe suggestions with detailed instructions and ingredient lists.';

    } else {
      // ── Mode 1: Shopping List Only ──
      systemPrompt = `You are a helpful shopping assistant. Generate shopping list items based on user requests. Categorize items (produce, dairy, meat, pantry, etc.) and provide brief reasons. Respond with JSON: { "suggestions": [{"item": "milk", "category": "dairy", "reason": "essential for breakfast", "price": 0.00}], "message": "helpful message" }`;
    }

    // ── Call GPT-4o ──
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1500,
      temperature: 0.7,
    });

    let result;
    try {
      result = JSON.parse(completion.choices[0].message.content);
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
      return errorResponse(res, 500, 'Failed to process AI response. Please try again.');
    }

    // ── Generate DALL-E images for each recipe ──
    const recipes = result.recipes || result.courses || [];
    let recipesWithImages = recipes;

    if (recipes.length > 0) {
      recipesWithImages = await Promise.all(
        recipes.map(async (recipe) => {
          const title = recipe.title || recipe.dishName;
          const description = recipe.description || '';
          const imageUrl = await generateRecipeImage(title, description);
          return { ...recipe, imageUrl };
        })
      );
    }

    successResponse(res, {
      suggestions: result.suggestions || [],
      recipes: recipesWithImages,
      message: result.message || 'Here are your shopping suggestions!',
    });
  } catch (error) {
    console.error('Generate list error:', error);
    errorResponse(res, 500, 'AI service error. Please try again.');
  }
});

module.exports = router;