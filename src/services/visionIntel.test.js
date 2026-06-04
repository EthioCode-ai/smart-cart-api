// src/services/visionIntel.test.js
// ============================================================
// Tests for VEPI scoring + normalization. Vision/search extraction
// is mocked at the OpenAI boundary; this suite focuses on the
// deterministic parts: parse robustness, normalization, and the
// scoring function (which carries the is_not exclusion guarantee).
// ============================================================

const {
  scoreProductForSearch,
  normalizeProductIntel,
  normalizeSearchIntel,
  parseJsonStrict,
  HARD_EXCLUDE,
} = require('./visionIntel');

describe('parseJsonStrict', () => {
  test('parses plain JSON', () => {
    expect(parseJsonStrict('{"a": 1}')).toEqual({ a: 1 });
  });
  test('strips markdown fences the model sometimes adds', () => {
    expect(parseJsonStrict('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonStrict('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });
  test('returns null on garbage', () => {
    expect(parseJsonStrict('not json')).toBeNull();
    expect(parseJsonStrict('')).toBeNull();
    expect(parseJsonStrict(null)).toBeNull();
  });
});

describe('normalizeProductIntel', () => {
  test('lowercases strings, defaults missing arrays to empty', () => {
    const n = normalizeProductIntel({
      product_type: 'Cheese',
      product_subtype: 'Parmesan',
      form: 'Wedge',
      is_a: ['Cheese', 'Italian Cheese'],
      confidence: 0.9,
    });
    expect(n.product_type).toBe('cheese');
    expect(n.product_subtype).toBe('parmesan');
    expect(n.form).toBe('wedge');
    expect(n.is_a).toEqual(['cheese', 'italian cheese']);
    expect(n.is_not).toEqual([]);
    expect(n.key_descriptors).toEqual([]);
    expect(n.confidence).toBe(0.9);
  });

  test('clamps confidence to [0,1]', () => {
    expect(normalizeProductIntel({ product_type: 'x', confidence: 2.5 }).confidence).toBe(1);
    expect(normalizeProductIntel({ product_type: 'x', confidence: -1 }).confidence).toBe(0);
  });

  test('defaults confidence to 0.5 when missing', () => {
    expect(normalizeProductIntel({ product_type: 'x' }).confidence).toBe(0.5);
  });

  test('returns null on garbage input', () => {
    expect(normalizeProductIntel(null)).toBeNull();
    expect(normalizeProductIntel('string')).toBeNull();
  });
});

describe('normalizeSearchIntel', () => {
  test('lowercases + defaults arrays', () => {
    const n = normalizeSearchIntel({
      search_type: 'Cheese',
      search_subtype: null,
      is_a: ['Cheese'],
    });
    expect(n.search_type).toBe('cheese');
    expect(n.search_subtype).toBeNull();
    expect(n.is_a).toEqual(['cheese']);
    expect(n.is_not).toEqual([]);
  });
});

describe('scoreProductForSearch - the Avi screenshot cases', () => {
  // The 4-row screenshot that motivated VEPI. After vision processing,
  // each product gets is_a / is_not arrays. A "parmesan cheese" search
  // should rank Belgioioso #1 and EXCLUDE the pizza and flautas.

  const PARMESAN_SEARCH = {
    search_type: 'cheese',
    search_subtype: 'parmesan',
    key_descriptors: ['parmesan'],
    is_a: ['cheese', 'parmesan', 'italian cheese'],
    is_not: [],
  };

  const BELGIOIOSO_PARMESAN = {
    product_type: 'cheese',
    product_subtype: 'parmesan',
    form: 'wedge',
    key_descriptors: ['aged', 'italian', 'hard cheese', 'parmesan'],
    is_a: ['cheese', 'parmesan', 'italian cheese', 'hard cheese'],
    is_not: [],
    confidence: 0.95,
  };

  const RED_BARON_CHEESE_PIZZA = {
    product_type: 'pizza',
    product_subtype: 'frozen',
    form: 'frozen',
    key_descriptors: ['frozen pizza', 'cheese pizza'],
    is_a: ['pizza', 'frozen meal', 'cheese pizza'],
    // This is the key field that lets us exclude it from cheese searches
    is_not: ['cheese'],
    confidence: 0.9,
  };

  const REALGOOD_FLAUTAS = {
    product_type: 'frozen meal',
    product_subtype: 'flautas',
    form: 'frozen',
    key_descriptors: ['chicken', 'cheese filling', 'tortilla'],
    is_a: ['frozen meal', 'mexican food', 'flautas'],
    is_not: ['cheese'],
    confidence: 0.85,
  };

  const WHIPPED_CREAM = {
    product_type: 'whipped cream',
    product_subtype: null,
    form: 'aerosol',
    key_descriptors: ['dessert topping', 'sweetened'],
    is_a: ['dairy topping', 'dessert topping'],
    is_not: ['cheese'],
    confidence: 0.95,
  };

  test('Belgioioso Parmesan scores HIGH on parmesan-cheese search', () => {
    const score = scoreProductForSearch(BELGIOIOSO_PARMESAN, PARMESAN_SEARCH);
    expect(score).toBeGreaterThan(150); // 100 type + 50 subtype + descriptor + is_a overlap, times confidence
  });

  test('Red Baron Cheese Pizza is HARD-EXCLUDED from parmesan-cheese search', () => {
    expect(scoreProductForSearch(RED_BARON_CHEESE_PIZZA, PARMESAN_SEARCH)).toBe(HARD_EXCLUDE);
  });

  test('Realgood Flautas is HARD-EXCLUDED', () => {
    expect(scoreProductForSearch(REALGOOD_FLAUTAS, PARMESAN_SEARCH)).toBe(HARD_EXCLUDE);
  });

  test('Whipped Cream is HARD-EXCLUDED', () => {
    expect(scoreProductForSearch(WHIPPED_CREAM, PARMESAN_SEARCH)).toBe(HARD_EXCLUDE);
  });

  test('Belgioioso ranks higher than a generic cheddar on parmesan search', () => {
    const CHEDDAR = {
      product_type: 'cheese',
      product_subtype: 'cheddar',
      key_descriptors: ['cheddar', 'sharp'],
      is_a: ['cheese', 'cheddar'],
      is_not: [],
      confidence: 0.9,
    };
    const belScore = scoreProductForSearch(BELGIOIOSO_PARMESAN, PARMESAN_SEARCH);
    const cheddarScore = scoreProductForSearch(CHEDDAR, PARMESAN_SEARCH);
    expect(belScore).toBeGreaterThan(cheddarScore);
  });
});

describe('scoreProductForSearch - edge cases', () => {
  test('returns 0 with null inputs', () => {
    expect(scoreProductForSearch(null, null)).toBe(0);
    expect(scoreProductForSearch({}, null)).toBe(0);
    expect(scoreProductForSearch(null, { search_type: 'x' })).toBe(0);
  });

  test('low confidence softly penalizes (multiplier 0.5..1.0)', () => {
    const high = { product_type: 'cheese', is_a: ['cheese'], is_not: [], confidence: 1.0 };
    const low  = { product_type: 'cheese', is_a: ['cheese'], is_not: [], confidence: 0.0 };
    const search = { search_type: 'cheese', is_a: ['cheese'], is_not: [], key_descriptors: [] };
    expect(scoreProductForSearch(high, search))
      .toBeGreaterThan(scoreProductForSearch(low, search));
  });

  test('is_not exclusion fires on search_type', () => {
    const product = { product_type: 'pizza', is_a: [], is_not: ['cheese'], confidence: 1 };
    const search = { search_type: 'cheese', is_a: [], is_not: [], key_descriptors: [] };
    expect(scoreProductForSearch(product, search)).toBe(HARD_EXCLUDE);
  });

  test('is_not exclusion also fires when search.is_a tag is in product.is_not', () => {
    // User searches "italian cheese" -> is_a includes ["cheese", "italian cheese"]
    // Pizza has is_not: ["cheese"] -> excluded even though we matched on the
    // broader is_a tag rather than search_type
    const product = { product_type: 'pizza', is_a: ['pizza'], is_not: ['cheese'], confidence: 1 };
    const search = {
      search_type: 'italian cheese',
      is_a: ['cheese', 'italian cheese'],
      is_not: [],
      key_descriptors: [],
    };
    expect(scoreProductForSearch(product, search)).toBe(HARD_EXCLUDE);
  });
});
