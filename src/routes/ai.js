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
      // Mock response if OpenAI not configured
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
      model: 'gpt-4-turbo-preview',
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
      // Mock recipe if OpenAI not configured
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
      model: 'gpt-4-turbo-preview',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 1000,
    });

    const recipe = JSON.parse(completion.choices[0].message.content);
    recipe.isAIGenerated = true;

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
      // Mock meal plan if OpenAI not configured
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
        summary: {
          goal,
          dailyCalories,
          dietType,
          days,
        },
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
    {"dayNumber": 1, "mealType": "lunch", "recipeName": "Meal Name", "calories": 500},
    ...
  ]
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 2000,
    });

    const result = JSON.parse(completion.choices[0].message.content);

    successResponse(res, {
      meals: result.meals,
      summary: {
        goal,
        dailyCalories,
        dietType,
        days,
      },
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

    // Get current list items if provided
    let currentItems = [];
    if (listId) {
      const itemsResult = await query(
        'SELECT name FROM list_items WHERE list_id = $1',
        [listId]
      );
      currentItems = itemsResult.rows.map(r => r.name);
    }

    if (!openai) {
      // Mock recommendations
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
      model: 'gpt-4-turbo-preview',
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
      // Mock complementary items
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
      model: 'gpt-4-turbo-preview',
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

    // Get store layout if available
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

    // Simple department-based ordering
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
      // Mock recognition
      return successResponse(res, {
        products: [
          { name: 'Apple', confidence: 0.95, department: 'Produce' },
          { name: 'Banana', confidence: 0.88, department: 'Produce' },
        ],
      });
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
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

// ── POST /api/ai/generate-list ─────────────────────────────────────
router.post('/generate-list', async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return errorResponse(res, 400, 'Prompt is required');
    }

    const context = await getUserContext(req.user.id);

    // Check for recipe-related keywords
    const recipeKeywords = ['recipe', 'cook', 'make', 'prepare', 'dish', 'meal', 'ingredients'];
    const isRecipeRequest = recipeKeywords.some(kw => prompt.toLowerCase().includes(kw));

    if (!openai) {
      // Fallback suggestions based on keywords
      const suggestions = generateFallbackSuggestions(prompt);
      return successResponse(res, {
        suggestions,
        recipes: [],
        message: `Here are shopping suggestions for: "${prompt}"`,
      });
    }

    const systemPrompt = `You are Smart Cart, an AI shopping assistant and culinary expert.
Based on the user's request, generate a shopping list with items they'll need.

User's dietary restrictions: ${context.dietaryRestrictions.join(', ') || 'None'}
User's allergens to AVOID: ${context.allergens.join(', ') || 'None'}

IMPORTANT: Never suggest items containing the user's allergens.

Respond ONLY with valid JSON in this exact format:
{
  "suggestions": [
    {"item": "item name", "category": "produce|meat|dairy|pantry|bakery|frozen|beverages|household", "reason": "why needed", "price": 0.00}
  ],
  "recipes": [
    {"title": "Recipe Name", "description": "Brief description", "prepTime": 30, "servings": 4, "difficulty": "Easy|Medium|Hard", "ingredients": ["item 1", "item 2"], "instructions": ["Step 1", "Step 2"]}
  ],
  "message": "Friendly summary message"
}

${isRecipeRequest ? 'Include 1-2 relevant recipes.' : 'No recipes needed, just shopping items.'}
Estimate realistic prices in USD.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1500,
      temperature: 0.7,
    });

    let result;
    try {
      const content = completion.choices[0].message.content;
      // Clean up potential markdown formatting
      const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();
      result = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
      // Return fallback on parse error
      const suggestions = generateFallbackSuggestions(prompt);
      return successResponse(res, {
        suggestions,
        recipes: [],
        message: `Here are shopping suggestions for: "${prompt}"`,
      });
    }

    successResponse(res, {
      suggestions: result.suggestions || [],
      recipes: result.recipes || [],
      message: result.message || 'Here are your shopping suggestions!',
    });
  } catch (error) {
    console.error('Generate list error:', error);
    // Return fallback on any error
    const suggestions = generateFallbackSuggestions(req.body.prompt || '');
    successResponse(res, {
      suggestions,
      recipes: [],
      message: 'Here are some suggestions based on your request.',
    });
  }
});

// Helper function for fallback suggestions
function generateFallbackSuggestions(prompt) {
  const lower = prompt.toLowerCase();
  
  if (lower.includes('steak') || lower.includes('beef')) {
    return [
      { item: 'ribeye steak', category: 'meat', reason: 'main protein for the meal', price: 15.99 },
      { item: 'salt', category: 'pantry', reason: 'to season the steak', price: 1.99 },
      { item: 'pepper', category: 'pantry', reason: 'for seasoning', price: 2.49 },
      { item: 'olive oil', category: 'pantry', reason: 'for cooking', price: 8.99 },
      { item: 'butter', category: 'dairy', reason: 'to baste the steak', price: 4.99 },
      { item: 'garlic', category: 'produce', reason: 'adds flavor when basting', price: 0.99 },
      { item: 'thyme', category: 'produce', reason: 'adds aroma and flavor', price: 2.99 },
      { item: 'potatoes', category: 'produce', reason: 'classic side dish', price: 3.99 },
      { item: 'asparagus', category: 'produce', reason: 'vegetable side dish', price: 4.49 },
    ];
  } else if (lower.includes('pasta') || lower.includes('spaghetti') || lower.includes('bolognese')) {
    return [
      { item: 'spaghetti', category: 'pantry', reason: 'base pasta for the dish', price: 1.99 },
      { item: 'ground beef', category: 'meat', reason: 'main protein for the sauce', price: 7.99 },
      { item: 'onion', category: 'produce', reason: 'adds flavor and aroma', price: 0.99 },
      { item: 'garlic', category: 'produce', reason: 'enhances the flavor', price: 0.99 },
      { item: 'carrot', category: 'produce', reason: 'adds sweetness to sauce', price: 1.49 },
      { item: 'celery', category: 'produce', reason: 'adds depth of flavor', price: 1.99 },
      { item: 'canned tomatoes', category: 'pantry', reason: 'base of the sauce', price: 2.49 },
      { item: 'tomato paste', category: 'pantry', reason: 'thickens and enriches sauce', price: 1.29 },
      { item: 'parmesan cheese', category: 'dairy', reason: 'for topping', price: 6.99 },
    ];
  } else if (lower.includes('taco') || lower.includes('mexican')) {
    return [
      { item: 'ground beef', category: 'meat', reason: 'taco filling base', price: 7.99 },
      { item: 'taco shells', category: 'bakery', reason: 'to hold the filling', price: 3.49 },
      { item: 'lettuce', category: 'produce', reason: 'fresh topping', price: 1.99 },
      { item: 'tomatoes', category: 'produce', reason: 'diced for topping', price: 2.49 },
      { item: 'cheese', category: 'dairy', reason: 'shredded for topping', price: 4.99 },
      { item: 'sour cream', category: 'dairy', reason: 'creamy topping', price: 2.99 },
      { item: 'taco seasoning', category: 'pantry', reason: 'flavors the meat', price: 1.49 },
      { item: 'onion', category: 'produce', reason: 'adds crunch and flavor', price: 0.99 },
    ];
  } else if (lower.includes('chicken')) {
    return [
      { item: 'chicken breast', category: 'meat', reason: 'main protein', price: 8.99 },
      { item: 'olive oil', category: 'pantry', reason: 'for cooking', price: 8.99 },
      { item: 'garlic', category: 'produce', reason: 'adds flavor', price: 0.99 },
      { item: 'lemon', category: 'produce', reason: 'for brightness', price: 0.79 },
      { item: 'rosemary', category: 'produce', reason: 'aromatic herb', price: 2.99 },
      { item: 'salt', category: 'pantry', reason: 'for seasoning', price: 1.99 },
      { item: 'pepper', category: 'pantry', reason: 'for seasoning', price: 2.49 },
    ];
  } else if (lower.includes('breakfast') || lower.includes('egg')) {
    return [
      { item: 'eggs', category: 'dairy', reason: 'breakfast protein', price: 4.99 },
      { item: 'bacon', category: 'meat', reason: 'classic breakfast side', price: 6.99 },
      { item: 'bread', category: 'bakery', reason: 'for toast', price: 3.49 },
      { item: 'butter', category: 'dairy', reason: 'for cooking and toast', price: 4.99 },
      { item: 'orange juice', category: 'beverages', reason: 'breakfast drink', price: 4.49 },
      { item: 'milk', category: 'dairy', reason: 'for coffee or cereal', price: 3.99 },
    ];
  } else if (lower.includes('salad') || lower.includes('healthy')) {
    return [
      { item: 'mixed greens', category: 'produce', reason: 'salad base', price: 4.99 },
      { item: 'cherry tomatoes', category: 'produce', reason: 'adds color and flavor', price: 3.99 },
      { item: 'cucumber', category: 'produce', reason: 'refreshing crunch', price: 1.49 },
      { item: 'avocado', category: 'produce', reason: 'healthy fats', price: 2.49 },
      { item: 'olive oil', category: 'pantry', reason: 'for dressing', price: 8.99 },
      { item: 'lemon', category: 'produce', reason: 'for dressing', price: 0.79 },
      { item: 'feta cheese', category: 'dairy', reason: 'adds protein and flavor', price: 5.99 },
    ];
  } else {
    // Generic suggestions
    return [
      { item: 'chicken breast', category: 'meat', reason: 'versatile protein', price: 8.99 },
      { item: 'rice', category: 'pantry', reason: 'staple grain', price: 3.99 },
      { item: 'broccoli', category: 'produce', reason: 'healthy vegetable', price: 2.99 },
      { item: 'olive oil', category: 'pantry', reason: 'for cooking', price: 8.99 },
      { item: 'garlic', category: 'produce', reason: 'adds flavor', price: 0.99 },
      { item: 'onion', category: 'produce', reason: 'base for many dishes', price: 0.99 },
      { item: 'salt', category: 'pantry', reason: 'essential seasoning', price: 1.99 },
      { item: 'pepper', category: 'pantry', reason: 'essential seasoning', price: 2.49 },
    ];
  }
}

module.exports = router;
