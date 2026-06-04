// src/services/categorization.test.js
// ============================================================
// Tests for SCA dictionary path (deterministic, no API key needed).
// AI fallback is mocked separately; not exercised in this suite.
// ============================================================

const {
  TAXONOMY,
  TAXONOMY_SET,
  categorizeByDictionary,
} = require('./categorization');

describe('SCA taxonomy', () => {
  test('includes Pasta & Sauces (the gap Avi identified)', () => {
    expect(TAXONOMY).toContain('Pasta & Sauces');
  });

  test('includes Other as the always-valid fallback', () => {
    expect(TAXONOMY).toContain('Other');
  });

  test('TAXONOMY_SET has the same membership as TAXONOMY', () => {
    expect(TAXONOMY_SET.size).toBe(TAXONOMY.length);
    for (const t of TAXONOMY) expect(TAXONOMY_SET.has(t)).toBe(true);
  });
});

describe('categorizeByDictionary - brand path', () => {
  test('Ragu (the example from Avi screenshot) -> Pasta & Sauces', () => {
    expect(categorizeByDictionary('Simply Roasted Garlic', 'Ragu')).toBe('Pasta & Sauces');
  });

  test('case-insensitive brand match', () => {
    expect(categorizeByDictionary('any', 'RAGU')).toBe('Pasta & Sauces');
    expect(categorizeByDictionary('any', 'ragu')).toBe('Pasta & Sauces');
    expect(categorizeByDictionary('any', '  Ragu  ')).toBe('Pasta & Sauces');
  });

  test('brand wins over name keyword when both could match', () => {
    // 'frozen' would match Frozen via keyword, but Ben & Jerry's brand wins
    expect(categorizeByDictionary('frozen pizza', 'Ben & Jerry\'s')).toBe('Frozen');
  });

  test('beverages brands', () => {
    expect(categorizeByDictionary('Cola', 'Pepsi')).toBe('Beverages');
    expect(categorizeByDictionary('Lemon Lime', 'Sprite')).toBe('Beverages');
    expect(categorizeByDictionary('Coffee', 'Starbucks')).toBe('Beverages');
  });

  test('condiments brands', () => {
    expect(categorizeByDictionary('Ketchup', 'Heinz')).toBe('Condiments');
    expect(categorizeByDictionary('Mayo', 'Hellmanns')).toBe('Condiments');
  });

  test('cereal brands', () => {
    expect(categorizeByDictionary('Special K', 'Kelloggs')).toBe('Cereal');
    expect(categorizeByDictionary('Oatmeal', 'Quaker')).toBe('Cereal');
  });

  test('baby brands', () => {
    expect(categorizeByDictionary('Formula Stage 1', 'Enfamil')).toBe('Baby');
    expect(categorizeByDictionary('Diapers', 'Huggies')).toBe('Baby');
  });

  test('pet brands', () => {
    expect(categorizeByDictionary('Dog Food', 'Purina')).toBe('Pet Supplies');
  });
});

describe('categorizeByDictionary - keyword path (no brand or unknown brand)', () => {
  test('pasta items by name', () => {
    expect(categorizeByDictionary('Spaghetti 1lb', null)).toBe('Pasta & Sauces');
    expect(categorizeByDictionary('Penne Rigate', null)).toBe('Pasta & Sauces');
    expect(categorizeByDictionary('Whole Wheat Linguine', null)).toBe('Pasta & Sauces');
    expect(categorizeByDictionary('Tomato Marinara Sauce', null)).toBe('Pasta & Sauces');
    expect(categorizeByDictionary('Pesto Genovese', null)).toBe('Pasta & Sauces');
  });

  test('dairy items', () => {
    expect(categorizeByDictionary('Whole Milk Gallon', null)).toBe('Dairy');
    expect(categorizeByDictionary('Greek Yogurt 32oz', null)).toBe('Dairy');
    expect(categorizeByDictionary('Sharp Cheddar Cheese', null)).toBe('Dairy');
  });

  test('produce items', () => {
    expect(categorizeByDictionary('Organic Bananas', null)).toBe('Produce');
    expect(categorizeByDictionary('Red Bell Pepper', null)).toBe('Produce');
    expect(categorizeByDictionary('Baby Spinach', null)).toBe('Produce');
  });

  test('frozen wins over pasta when both keywords present', () => {
    // 'frozen' pattern is ordered before pasta keyword fallback
    expect(categorizeByDictionary('Frozen Pizza Pepperoni', null)).toBe('Frozen');
  });

  test('bakery items', () => {
    expect(categorizeByDictionary('Sourdough Bread Loaf', null)).toBe('Bakery');
    expect(categorizeByDictionary('Croissant 6-pack', null)).toBe('Bakery');
  });

  test('beverages items', () => {
    expect(categorizeByDictionary('Orange Juice 64oz', null)).toBe('Beverages');
    expect(categorizeByDictionary('Sparkling Water Lime', null)).toBe('Beverages');
    expect(categorizeByDictionary('Iced Coffee', null)).toBe('Beverages');
  });

  test('meat / seafood / snacks / condiments / canned / household', () => {
    expect(categorizeByDictionary('Ground Beef 1lb', null)).toBe('Meat');
    expect(categorizeByDictionary('Atlantic Salmon Fillet', null)).toBe('Seafood');
    expect(categorizeByDictionary('Lays Potato Chips', null)).toBe('Snacks');
    expect(categorizeByDictionary('Yellow Mustard 12oz', null)).toBe('Condiments');
    expect(categorizeByDictionary('Canned Black Beans', null)).toBe('Canned Goods');
    expect(categorizeByDictionary('Paper Towel 6-roll', null)).toBe('Household');
  });
});

describe('categorizeByDictionary - returns null when no match', () => {
  test('unknown brand, unknown name returns null (so AI fallback can fire)', () => {
    expect(categorizeByDictionary('Frobozz Sproket', 'GlorpCorp')).toBeNull();
    expect(categorizeByDictionary('xyzzy', null)).toBeNull();
  });

  test('null/undefined inputs return null safely', () => {
    expect(categorizeByDictionary(null, null)).toBeNull();
    expect(categorizeByDictionary(undefined, undefined)).toBeNull();
    expect(categorizeByDictionary('', '')).toBeNull();
  });

  test('non-string inputs return null safely', () => {
    expect(categorizeByDictionary(123, null)).toBeNull();
    expect(categorizeByDictionary(null, { brand: 'Ragu' })).toBeNull();
  });
});

describe('categorizeByDictionary - the Ragu screenshot case', () => {
  test('the four products from the screenshot get distinct correct categories', () => {
    // Avi's screenshot showed these 4 products all tagged 'grocery'.
    // Post-SCA they should split (dictionary path):
    expect(categorizeByDictionary('Simply Roasted Garlic Sauce', 'Ragu')).toBe('Pasta & Sauces');
    // Veggie Fries / Farmwise: no dict match -> null, AI fallback would categorize
    // (likely as Frozen or Snacks). Asserting null here documents the boundary
    // between fast-path coverage and what's expected to go to AI.
    expect(categorizeByDictionary('Veggie Fries', 'Farmwise')).toBeNull();
    expect(categorizeByDictionary('Roasted Red Pepper Hummus', null)).toBe('Condiments');
    expect(categorizeByDictionary('Salsa Roasted', 'Kylito\'s')).toBe('Condiments'); // salsa keyword
  });
});
