// src/routes/ai.js
// ============================================================
// AI Routes (OpenAI Integration) — GPT-Driven Mode Detection
// ============================================================

const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

let openai = null;
try {
  const OpenAI = require('openai');
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
} catch (error) {
  console.warn('OpenAI not configured. AI features will return mock data.');
}

const DEFAULT_RECIPE_IMAGE = 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&h=400&fit=crop';

// ── Helper: Generate recipe image with DALL-E ───────────────

const generateRecipeImage = async (recipeTitle, recipeDescription, keyIngredients) => {
  if (!openai || !recipeTitle) return DEFAULT_RECIPE_IMAGE;
  try {
    // Build ingredient context for accuracy
    const ingredientText = keyIngredients && keyIngredients.length > 0
      ? `Key visible ingredients: ${keyIngredients.slice(0, 8).join(', ')}.`
      : '';

    const prompt = [
      `Hyper-realistic professional food photography of "${recipeTitle}".`,
      recipeDescription ? `Description: ${recipeDescription}.` : '',
      ingredientText,
      `The image MUST accurately depict this specific dish — correct ingredients, authentic textures, proper colors, and traditional presentation.`,
      `Style: shot on Canon EOS R5, 50mm f/1.8 lens, softbox lighting from upper left, shallow depth of field, clean white ceramic plate on marble countertop, steam rising, fresh herbs as garnish, editorial quality for a premium food magazine.`,
      `Do NOT add any text, labels, watermarks, or words to the image.`,
    ].filter(Boolean).join(' ');

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

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an expert chef. Generate detailed recipes with precise ingredients and clear instructions. Always consider dietary restrictions and allergens. Respond in JSON format only.`
        },
        {
          role: 'user',
          content: `Generate a recipe with the following requirements:
${ingredients ? `- Include these ingredients: ${ingredients.join(', ')}` : ''}
${cuisine ? `- Cuisine style: ${cuisine}` : ''}
- Servings: ${servings}
${mealType ? `- Meal type: ${mealType}` : ''}
${context.dietaryRestrictions.length ? `- Dietary restrictions: ${context.dietaryRestrictions.join(', ')}` : ''}
${context.allergens.length ? `- Avoid allergens: ${context.allergens.join(', ')}` : ''}

Respond in JSON:
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
}`
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1000,
    });

    const recipe = JSON.parse(completion.choices[0].message.content);
    recipe.isAIGenerated = true;

    const imageUrl = await generateRecipeImage(recipe.title, recipe.description);
    recipe.imageUrl = imageUrl;

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

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a professional meal planning nutritionist. Create balanced meal plans that meet nutritional goals and dietary preferences. Always consider the user's restrictions and allergens. Respond in JSON format only.`
        },
        {
          role: 'user',
          content: `Generate a ${days}-day meal plan with:
- Goal: ${goal || 'General health'}
- Daily calories: ${dailyCalories}
- Diet type: ${dietType || 'Balanced'}
${context.dietaryRestrictions.length ? `- Dietary restrictions: ${context.dietaryRestrictions.join(', ')}` : ''}
${context.allergens.length ? `- Avoid allergens: ${context.allergens.join(', ')}` : ''}

For each day, include breakfast, lunch, dinner, and one snack.

Respond in JSON:
{
  "meals": [
    {"dayNumber": 1, "mealType": "breakfast", "recipeName": "Meal Name", "calories": 400},
    {"dayNumber": 1, "mealType": "lunch", "recipeName": "Meal Name", "calories": 500}
  ]
}`
        }
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

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a smart grocery shopping assistant. Suggest items based on what the user already has, considering dietary needs and common meal patterns. Respond in JSON format only.`
        },
        {
          role: 'user',
          content: `Based on a shopping list containing: ${currentItems.join(', ') || 'nothing yet'}

Suggest 5 grocery items the user might need.
Consider dietary restrictions: ${context.dietaryRestrictions.join(', ') || 'None'}
Avoid allergens: ${context.allergens.join(', ') || 'None'}

Respond in JSON:
{
  "recommendations": [
    {"name": "Item", "reason": "Why suggested", "department": "Store department"}
  ]
}`
        }
      ],
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

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a grocery shopping expert. Suggest complementary items that pair well together or complete a meal. Respond in JSON format only.`
        },
        {
          role: 'user',
          content: `Given these grocery items: ${items.join(', ')}

Suggest 5 complementary items that would pair well or complete a meal.

Respond in JSON: {"suggestions": ["item1", "item2", "item3", "item4", "item5"]}`
        }
      ],
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
          role: 'system',
          content: `You are a grocery product identification expert. Analyze images to identify food items, brands, and products with high accuracy. Respond in JSON format only.`
        },
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
      response_format: { type: 'json_object' },
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
//
// UNIFIED AI ENDPOINT — GPT-Driven Mode Detection
//
// Instead of keyword detection, GPT-4o decides the mode by
// returning a "mode" field in its JSON response. This handles
// ambiguous requests much better than keyword matching.
//
// 4 modes:
//   "shopping_list" — user wants items to buy
//   "recipe"        — user wants cooking instructions + ingredients
//   "full_course"   — user wants a multi-course meal experience
//   "chat"          — general question, advice, or conversation
//
// Examples keyword detection would get WRONG:
//   "I'm hosting Saturday"            → full_course
//   "What goes with chicken?"         → shopping_list
//   "Help me use up my leftover rice" → recipe
//   "Stuff for tacos"                 → shopping_list
//   "Teach me to make pasta"          → recipe
//   "What's a good substitute for butter?" → chat
//   "How long does chicken last in the fridge?" → chat
// ─────────────────────────────────────────────────────────────

router.post('/generate-list', async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return errorResponse(res, 400, 'Prompt is required');
    }

    if (!openai) {
      return errorResponse(res, 503, 'AI service is temporarily unavailable. Please try again later.');
    }

    const context = await getUserContext(req.user.id);

    const systemPrompt = `You are Smart Cart, an expert AI shopping assistant, chef, and meal planner.

User's dietary restrictions: ${context.dietaryRestrictions.join(', ') || 'None'}
User's allergens: ${context.allergens.join(', ') || 'None'}

Analyze the user's message and determine the best response mode:

MODE 1 — "shopping_list": User wants items to buy (groceries, supplies, ingredients for a quick meal).
MODE 2 — "recipe": User wants a recipe, cooking instructions, or asks how to make/cook/prepare something.
MODE 3 — "full_course": User wants a multi-course meal, dinner party menu, or complete dining experience.
MODE 4 — "chat": User is asking a general food/cooking question, seeking advice, or making conversation that doesn't need a list or recipe. Examples: substitution questions, food storage tips, cooking techniques, nutrition questions.

You MUST include a "mode" field in your response so the app knows how to display the results.

Respond in JSON with ONE of these structures based on your chosen mode:

If mode is "shopping_list":
{
  "mode": "shopping_list",
  "listName": "A short, smart title for this shopping list (e.g. 'Weekly Groceries', 'Taco Night', 'BBQ Essentials'). Never use the user's raw command as the title. Summarize the intent in 2-4 words.",
  "suggestions": [{"item": "milk", "category": "dairy", "reason": "essential staple", "price": 3.49}],
  "message": "friendly summary"
}

If mode is "recipe":
{
  "mode": "recipe",
  "listName": "Short title for the ingredient list (e.g. 'Spaghetti Bolognese Ingredients')",
  "suggestions": [{"item": "ground beef", "category": "meat", "reason": "main protein", "price": 6.99}],
  "recipes": [{
    "title": "Recipe Name",
    "description": "Brief description",
    "ingredients": [{"item": "ground beef", "quantity": "2", "unit": "lbs", "category": "meat", "price": 6.99}],
    "instructions": ["Step 1...", "Step 2..."],
    "prepTime": 25,
    "servings": 4,
    "difficulty": "Easy|Medium|Hard",
    "tags": ["dinner", "mexican"]
  }],
  "message": "friendly summary"
}

If mode is "full_course":
{
  "mode": "full_course",
  "listName": "Short title for the meal (e.g. 'Steak Dinner for Two')",
  "courses": [{
    "courseType": "appetizer|main|side|dessert|beverage",
    "dishName": "Dish Name",
    "description": "Brief description",
    "ingredients": [{"item": "name", "quantity": "1", "unit": "lb", "category": "meat", "price": 5.99}],
    "prepTime": 30,
    "difficulty": "Easy|Medium|Hard"
  }],
  "mealTheme": "Theme name",
  "servings": 4,
  "message": "friendly summary"
}

If mode is "chat":
{
  "mode": "chat",
  "response": "Your helpful, conversational answer here.",
  "suggestions": ["Follow-up suggestion 1", "Follow-up suggestion 2", "Follow-up suggestion 3"],
  "message": "friendly summary"
}

Important rules:
- If the user has dietary restrictions, mention them but don't force them. Give classic recipes unless the user explicitly asks for alternatives.
- Be specific with ingredient quantities
- For recipes, include both the shopping list items AND the recipe details
- For full course, include all courses (appetizer, main, side, dessert)
- For chat, be concise, friendly, and actionable — suggest next steps the user might want to take
- Choose the mode that BEST matches the user's true intent, not just keywords
- For all suggestions, estimate realistic US grocery store prices in USD for each item. Never use 0.00 as a price.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000,
      temperature: 0.7,
    });

    let result;
    try {
      result = JSON.parse(completion.choices[0].message.content);
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
      return errorResponse(res, 500, 'Failed to process AI response. Please try again.');
    }

    const mode = result.mode || 'shopping_list';

    // ── Image generation logic ──────────────────────────────
    // recipe mode:      one image per recipe (usually just 1 recipe)
    // full_course mode: one hero image for the meal theme (not per course)
    // chat/shopping:    no images needed

    // Assign placeholder images — real images load async via /api/ai/generate-image
    if (mode === 'recipe' && result.recipes && result.recipes.length > 0) {
      result.recipes = result.recipes.map(recipe => ({
        ...recipe,
        imageUrl: DEFAULT_RECIPE_IMAGE,
      }));
    }
    let heroImageUrl = DEFAULT_RECIPE_IMAGE;

    // ── Build response based on mode ────────────────────────

    const response = {
      mode,
      message: result.message || 'Here are your results!',
    };

    if (mode === 'shopping_list') {
      response.suggestions = result.suggestions || [];
    } else if (mode === 'recipe') {
      response.suggestions = result.suggestions || [];
      response.recipes = result.recipes || [];
    } else if (mode === 'full_course') {
      response.courses = result.courses || [];
      response.mealTheme = result.mealTheme || '';
      response.servings = result.servings || 4;
      response.heroImageUrl = heroImageUrl || DEFAULT_RECIPE_IMAGE;
    } else if (mode === 'chat') {
      response.response = result.response || result.message || '';
      response.suggestions = result.suggestions || [];
    }

    successResponse(res, response);
  } catch (error) {
    console.error('Generate list error:', error);
    errorResponse(res, 500, 'AI service error. Please try again.');
  }
});

// ── POST /api/ai/transcribe ─────────────────────────────────
//
// Speech-to-text via OpenAI Whisper.
// Receives base64-encoded audio from the mobile app,
// writes to a temp file, sends to Whisper, returns text.
// The frontend then feeds the text into /generate-list.
// ─────────────────────────────────────────────────────────────

router.post('/transcribe', async (req, res) => {
  try {
    const { audio } = req.body;

    if (!audio) {
      return errorResponse(res, 400, 'Audio data is required');
    }

    if (!openai) {
      return errorResponse(res, 503, 'AI service is temporarily unavailable.');
    }

    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const tempPath = path.join(os.tmpdir(), `recording-${Date.now()}.m4a`);
    const audioBuffer = Buffer.from(audio, 'base64');
    fs.writeFileSync(tempPath, audioBuffer);

    try {
      const transcription = await openai.audio.transcriptions.create({
        model: 'whisper-1',
        file: fs.createReadStream(tempPath),
        language: 'en',
      });

      successResponse(res, { text: transcription.text });
    } finally {
      try { fs.unlinkSync(tempPath); } catch (e) { /* cleanup best-effort */ }
    }
  } catch (error) {
    console.error('Transcription error:', error);
    errorResponse(res, 500, 'Failed to transcribe audio. Please try again.');
  }
});

// ── POST /api/ai/generate-image ─────────────────────────────
// Async image generation — called AFTER results are rendered
router.post('/generate-image', async (req, res) => {
  try {
    const { title, description, ingredients } = req.body;
    if (!title) {
      return errorResponse(res, 400, 'Title is required');
    }
    const imageUrl = await generateRecipeImage(title, description || '', ingredients || []);
    successResponse(res, { imageUrl });
  } catch (error) {
    console.error('Generate image error:', error);
    successResponse(res, { imageUrl: DEFAULT_RECIPE_IMAGE });
  }
});

// ── POST /api/ai/price-items ────────────────────────────────
// Lightweight endpoint to price and categorize items for list editing
router.post('/price-items', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) {
      return errorResponse(res, 400, 'Items array is required');
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a grocery pricing assistant. Given a list of item names, return a JSON array with each item's name, estimated US grocery store price in USD, and department category.
Respond ONLY with JSON, no markdown or explanation:
[{"name": "eggs", "price": 3.99, "department": "dairy"}, ...]
Valid departments: dairy, bakery, produce, meat, seafood, frozen, beverages, snacks, pantry, household, other`
        },
        { role: 'user', content: items.join(', ') },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 500,
      temperature: 0.3,
    });

    let result;
    try {
      const raw = completion.choices[0].message.content;
      console.log('price-items GPT raw response:', raw);
      const parsed = JSON.parse(raw);
      result = Array.isArray(parsed) ? parsed
        : parsed.items || parsed.data || parsed.results || Object.values(parsed).find(v => Array.isArray(v))
        || [parsed];
      console.log('price-items parsed result:', JSON.stringify(result));
    } catch (e) {
      result = items.map(name => ({ name, price: 2.99, department: 'grocery' }));
    }

    successResponse(res, { items: result });
  } catch (error) {
    console.error('Price items error:', error);
    // Fallback — return items with default prices
    successResponse(res, {
      items: (req.body.items || []).map(name => ({ name, price: 2.99, department: 'grocery' })),
    });
  }
});

module.exports = router;