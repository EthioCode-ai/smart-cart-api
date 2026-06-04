// src/services/categorization.js
// ============================================================
// Smart Category Allocation (SCA) - v2.0.9
//
// Categorizes products into a flat grocery taxonomy. Two paths:
//   1. DICTIONARY (fast, deterministic, zero cost)
//      - brand -> category map (exact match on lowercased brand)
//      - keyword patterns on the product name (priority-ordered regex)
//   2. AI FALLBACK (slow, ~$0.00015 per call, broad coverage)
//      - GPT-4o-mini with a constrained-output prompt
//      - Returns a single taxonomy key, or 'Other' on uncertainty
//
// The dictionary catches ~80% of common products instantly. The AI
// fallback handles the long tail. Both are cached in products.category
// so each product is categorized exactly once.
//
// This module is PURE - no DB access. The categorize() function takes
// (name, brand) and returns a category string. DB read/write happens
// in the worker (categorizationWorker.js).
// ============================================================

let openai = null;
try {
  const OpenAI = require('openai');
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
} catch (err) {
  console.warn('SCA: OpenAI not available, AI fallback disabled');
}

// ── Taxonomy ─────────────────────────────────────────────────
// Matches the frontend DEPARTMENT_COLORS keys in src/config/index.js,
// plus 'Pasta & Sauces' added in this PR. The frontend gets the same
// addition so the rendered chip/badge colors line up.
const TAXONOMY = [
  'Produce', 'Dairy', 'Meat', 'Seafood', 'Bakery', 'Deli', 'Frozen',
  'Beverages', 'Snacks', 'Cereal', 'Canned Goods', 'Condiments',
  'Pasta & Sauces',
  'Health & Beauty', 'Household', 'Pharmacy', 'Electronics', 'Automotive',
  'Home & Garden', 'Appliances', 'Floral', 'Pet Supplies', 'Sporting Goods',
  'Toys', 'Baby', 'Other',
];
const TAXONOMY_SET = new Set(TAXONOMY);

// ── Dictionary: brand -> category ────────────────────────────
// Keys are lowercased; lookup normalizes input. Add liberally; this is
// the fast path. The first known-brand match wins.
const BRAND_CATEGORY = {
  // Pasta & Sauces
  'ragu': 'Pasta & Sauces',
  'prego': 'Pasta & Sauces',
  'barilla': 'Pasta & Sauces',
  'bertolli': 'Pasta & Sauces',
  'rao\'s': 'Pasta & Sauces',
  'classico': 'Pasta & Sauces',
  'newman\'s own': 'Pasta & Sauces',
  'de cecco': 'Pasta & Sauces',
  'ronzoni': 'Pasta & Sauces',
  // Beverages
  'coca-cola': 'Beverages', 'coca cola': 'Beverages', 'coke': 'Beverages',
  'pepsi': 'Beverages',
  'gatorade': 'Beverages',
  'powerade': 'Beverages',
  'red bull': 'Beverages',
  'monster': 'Beverages',
  'sprite': 'Beverages',
  'dr pepper': 'Beverages',
  'starbucks': 'Beverages',
  'folgers': 'Beverages',
  'maxwell house': 'Beverages',
  'lipton': 'Beverages',
  'tropicana': 'Beverages',
  'minute maid': 'Beverages',
  'simply orange': 'Beverages',
  // Condiments
  'heinz': 'Condiments',
  'hellmann\'s': 'Condiments', 'hellmanns': 'Condiments',
  'kraft': 'Condiments',
  'french\'s': 'Condiments', 'frenchs': 'Condiments',
  'sriracha': 'Condiments',
  'tabasco': 'Condiments',
  'mccormick': 'Condiments',
  'kikkoman': 'Condiments',
  // Cereal / Breakfast
  'general mills': 'Cereal',
  'kellogg\'s': 'Cereal', 'kelloggs': 'Cereal',
  'post': 'Cereal',
  'quaker': 'Cereal',
  'cheerios': 'Cereal',
  // Frozen
  'haagen-dazs': 'Frozen', 'haagen dazs': 'Frozen',
  'ben & jerry\'s': 'Frozen', 'ben and jerrys': 'Frozen',
  'digiorno': 'Frozen',
  'birds eye': 'Frozen',
  'ore-ida': 'Frozen', 'ore ida': 'Frozen',
  // Dairy
  'chobani': 'Dairy',
  'yoplait': 'Dairy',
  'philadelphia': 'Dairy',
  'land o\'lakes': 'Dairy', 'land o lakes': 'Dairy',
  'horizon organic': 'Dairy',
  // Snacks
  'lay\'s': 'Snacks', 'lays': 'Snacks',
  'doritos': 'Snacks',
  'pringles': 'Snacks',
  'cheetos': 'Snacks',
  'oreo': 'Snacks',
  'm&m\'s': 'Snacks', 'm&ms': 'Snacks',
  'hershey\'s': 'Snacks', 'hersheys': 'Snacks',
  'snickers': 'Snacks',
  // Baby
  'gerber': 'Baby',
  'huggies': 'Baby',
  'pampers': 'Baby',
  'enfamil': 'Baby',
  'similac': 'Baby',
  // Pet
  'purina': 'Pet Supplies',
  'iams': 'Pet Supplies',
  'meow mix': 'Pet Supplies',
  'friskies': 'Pet Supplies',
  'pedigree': 'Pet Supplies',
  // Household
  'tide': 'Household',
  'dawn': 'Household',
  'clorox': 'Household',
  'lysol': 'Household',
  'bounty': 'Household',
  'charmin': 'Household',
  // Health & Beauty
  'colgate': 'Health & Beauty',
  'crest': 'Health & Beauty',
  'dove': 'Health & Beauty',
  'gillette': 'Health & Beauty',
};

// ── Dictionary: keyword patterns on product name ─────────────
// Priority-ordered. Earlier patterns win. Be careful with broad terms
// like 'sauce' (Condiments could compete with Pasta & Sauces) - put
// the more specific match first.
const KEYWORD_PATTERNS = [
  // Pasta & Sauces (specific pasta items + sauces)
  { pattern: /\b(spaghetti|linguine|penne|rigatoni|fettuccine|lasagna|ravioli|gnocchi|tortellini|orzo|farfalle|fusilli|rotini|ziti)\b/i, category: 'Pasta & Sauces' },
  { pattern: /\b(marinara|alfredo|pesto|bolognese|pomodoro|arrabbiata|carbonara)\b/i, category: 'Pasta & Sauces' },
  { pattern: /\b(pasta sauce|pasta noodle|tomato sauce)\b/i, category: 'Pasta & Sauces' },
  { pattern: /\b(macaroni)\b/i, category: 'Pasta & Sauces' },
  // Condiments - MUST come before Produce so "Red Pepper Hummus" -> Condiments
  // (not Produce via 'pepper'). Same for "Pickle Chips" -> Condiments not Snacks.
  { pattern: /\b(ketchup|mustard|mayo|mayonnaise|dressing|vinegar|soy sauce|hot sauce|salsa|hummus|guacamole|relish|pickles?)\b/i, category: 'Condiments' },
  // Snacks - MUST come before Produce so "Potato Chips" -> Snacks (not Produce via 'potato')
  // and "Apple Cookies" -> Snacks (not Produce via 'apple').
  { pattern: /\b(chips|crackers|pretzels|popcorn|candy|chocolate|cookies|cookie|granola bar|trail mix|gummy|jerky|nuts|almonds|cashews|peanuts)\b/i, category: 'Snacks' },
  // Dairy
  { pattern: /\b(milk|yogurt|yoghurt|cheese|butter|cream|cottage cheese|ricotta|mozzarella|cheddar|parmesan|brie|gouda|feta|sour cream|half and half)\b/i, category: 'Dairy' },
  // Bakery
  { pattern: /\b(bread|bagel|muffin|croissant|donut|doughnut|pastry|baguette|brioche|sourdough|focaccia)s?\b/i, category: 'Bakery' },
  // Frozen (catch frozen pizza before pasta-pizza confusion)
  { pattern: /\b(frozen|ice cream|gelato|sorbet|sherbet|frozen yogurt|popsicle)\b/i, category: 'Frozen' },
  // Beverages
  { pattern: /\b(juice|soda|cola|sparkling water|seltzer|energy drink|sports drink|kombucha|lemonade)\b/i, category: 'Beverages' },
  { pattern: /\b(coffee|espresso|latte|cappuccino|tea)\b/i, category: 'Beverages' },
  // Meat
  { pattern: /\b(chicken|beef|pork|lamb|turkey|sausage|bacon|ham|salami|pepperoni|hot dog|brisket|ribs)\b/i, category: 'Meat' },
  // Seafood
  { pattern: /\b(salmon|tuna|shrimp|lobster|crab|tilapia|cod|halibut|snapper|mahi|sardine|anchovy)\b/i, category: 'Seafood' },
  // Produce - plurals via s? suffix; tomatoes via separate alternation
  { pattern: /\b(apples?|bananas?|oranges?|grapes?|berries|berry|strawberry|strawberries|blueberry|blueberries|raspberry|raspberries|blackberry|blackberries|lettuce|spinach|kale|arugula|broccoli|carrots?|celery|onions?|garlic|tomato|tomatoes|cucumbers?|potato|potatoes|sweet potato|sweet potatoes|avocados?|lemons?|limes?|peppers?|bell peppers?|cilantro|parsley|basil)\b/i, category: 'Produce' },
  // Cereal / Breakfast
  { pattern: /\b(cereal|oatmeal|granola|muesli|pancake|waffle|syrup|maple)\b/i, category: 'Cereal' },
  // Canned Goods
  { pattern: /\b(canned|soup|broth|stock|chickpeas|garbanzo|black beans|kidney beans|pinto beans|lentils)\b/i, category: 'Canned Goods' },
  // Household
  { pattern: /\b(detergent|soap|cleaner|bleach|paper towel|toilet paper|napkin|trash bag|aluminum foil|plastic wrap|sponge)\b/i, category: 'Household' },
  // Pet
  { pattern: /\b(dog food|cat food|pet food|kibble|cat litter|dog treat|cat treat)\b/i, category: 'Pet Supplies' },
  // Baby
  { pattern: /\b(baby|infant|formula|diaper|wipes)\b/i, category: 'Baby' },
  // Health & Beauty
  { pattern: /\b(shampoo|conditioner|deodorant|toothpaste|mouthwash|lotion|sunscreen|razor)\b/i, category: 'Health & Beauty' },
  // Pharmacy
  { pattern: /\b(aspirin|ibuprofen|tylenol|advil|vitamin|supplement|multivitamin|melatonin|cough syrup|cold medicine)\b/i, category: 'Pharmacy' },
  // Floral
  { pattern: /\b(roses|flowers|bouquet|tulips)\b/i, category: 'Floral' },
];

const categorizeByDictionary = (name, brand) => {
  // Brand match first (most reliable)
  if (brand && typeof brand === 'string') {
    const brandKey = brand.trim().toLowerCase();
    if (BRAND_CATEGORY[brandKey]) return BRAND_CATEGORY[brandKey];
  }
  // Keyword pattern match on name
  if (name && typeof name === 'string') {
    for (const { pattern, category } of KEYWORD_PATTERNS) {
      if (pattern.test(name)) return category;
    }
  }
  return null;
};

const categorizeByAI = async (name, brand) => {
  if (!openai) return null;
  const productLabel = brand ? `${brand} ${name}` : name;
  const taxonomyList = TAXONOMY.join(', ');
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a grocery store categorizer. Given a product name, respond with EXACTLY ONE category from this list: ${taxonomyList}. Respond with only the category name, nothing else. If uncertain, respond "Other".`,
        },
        {
          role: 'user',
          content: productLabel,
        },
      ],
      max_tokens: 20,
      temperature: 0,
    });
    const raw = (completion.choices[0]?.message?.content || '').trim();
    // Validate against taxonomy - AI sometimes drifts despite instructions
    if (TAXONOMY_SET.has(raw)) return raw;
    // Case-insensitive fallback
    const match = TAXONOMY.find(t => t.toLowerCase() === raw.toLowerCase());
    return match || 'Other';
  } catch (err) {
    console.error('SCA AI categorization error:', err.message);
    return null;
  }
};

const categorize = async (name, brand) => {
  const fastPath = categorizeByDictionary(name, brand);
  if (fastPath) return { category: fastPath, method: 'dictionary' };
  const aiPath = await categorizeByAI(name, brand);
  if (aiPath) return { category: aiPath, method: 'ai' };
  return { category: 'Other', method: 'fallback' };
};

module.exports = {
  TAXONOMY,
  TAXONOMY_SET,
  BRAND_CATEGORY,
  KEYWORD_PATTERNS,
  categorizeByDictionary,
  categorizeByAI,
  categorize,
};
