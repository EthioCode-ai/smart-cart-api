// src/utils/priceValidator.test.js
const { validatePriceWrite } = require('./priceValidator');

// Helper to build a base valid input — tests only override the fields they care about
const baseInput = (overrides = {}) => ({
  barcode: '012345678905',
  price: 5.79,
  confidence: 0.95,
  source: 'gpt_vision',
  existingMarketPrice: null,
  ...overrides,
});

describe('validatePriceWrite — bounds', () => {
  test('rejects price below floor', () => {
    expect(validatePriceWrite(baseInput({ price: 0.09 })))
      .toEqual({ decision: 'reject', reason: 'bounds_violation' });
  });

  test('accepts price exactly at floor ($0.10)', () => {
    expect(validatePriceWrite(baseInput({ price: 0.10 })).decision).toBe('accept');
  });

  test('accepts price exactly at ceiling ($500)', () => {
    expect(validatePriceWrite(baseInput({ price: 500.00 })).decision).toBe('accept');
  });

  test('rejects price above ceiling', () => {
    expect(validatePriceWrite(baseInput({ price: 500.01 })))
      .toEqual({ decision: 'reject', reason: 'bounds_violation' });
  });

  test('rejects negative price', () => {
    expect(validatePriceWrite(baseInput({ price: -5 })))
      .toEqual({ decision: 'reject', reason: 'bounds_violation' });
  });

  test('rejects zero price', () => {
    expect(validatePriceWrite(baseInput({ price: 0 })))
      .toEqual({ decision: 'reject', reason: 'bounds_violation' });
  });

  test('rejects NaN price', () => {
    expect(validatePriceWrite(baseInput({ price: NaN })))
      .toEqual({ decision: 'reject', reason: 'bounds_violation' });
  });

  test('rejects null price', () => {
    expect(validatePriceWrite(baseInput({ price: null })))
      .toEqual({ decision: 'reject', reason: 'bounds_violation' });
  });

  test('rejects string price (no implicit coercion)', () => {
    expect(validatePriceWrite(baseInput({ price: '5.79' })))
      .toEqual({ decision: 'reject', reason: 'bounds_violation' });
  });
});

describe('validatePriceWrite — confidence (camera sources)', () => {
  test('quarantines gpt_vision scan with confidence below threshold', () => {
    expect(validatePriceWrite(baseInput({ source: 'gpt_vision', confidence: 0.69 })))
      .toEqual({ decision: 'quarantine', reason: 'low_confidence' });
  });

  test('accepts gpt_vision scan at confidence threshold (0.70)', () => {
    expect(validatePriceWrite(baseInput({ source: 'gpt_vision', confidence: 0.70 })).decision).toBe('accept');
  });

  test('accepts walk_scan source when confidence missing (degrades to assumed-good 0.85)', () => {
    // Backwards-compat: older clients / network hiccups shouldn't silently quarantine every scan
    expect(validatePriceWrite(baseInput({ source: 'walk_scan', confidence: undefined })).decision).toBe('accept');
  });

  test('accepts walk_scan source when confidence is null (degrades to assumed-good 0.85)', () => {
    expect(validatePriceWrite(baseInput({ source: 'walk_scan', confidence: null })).decision).toBe('accept');
  });

  test('still quarantines camera source with HONEST low-confidence (cooperative client)', () => {
    expect(validatePriceWrite(baseInput({ source: 'gpt_vision', confidence: 0.3 })))
      .toEqual({ decision: 'quarantine', reason: 'low_confidence' });
  });

  test('respects custom missingConfidenceDefault below threshold (configurable trap)', () => {
    // If someone tunes the default below threshold, missing-conf SHOULD quarantine
    expect(validatePriceWrite(
      baseInput({ source: 'walk_scan', confidence: undefined }),
      { missingConfidenceDefault: 0.5 }
    ))
      .toEqual({ decision: 'quarantine', reason: 'low_confidence' });
  });

  test('skips confidence check for non-camera sources (manual)', () => {
    expect(validatePriceWrite(baseInput({ source: 'manual', confidence: undefined })).decision).toBe('accept');
  });

  test('skips confidence check when source is undefined', () => {
    expect(validatePriceWrite(baseInput({ source: undefined, confidence: undefined })).decision).toBe('accept');
  });
});

describe('validatePriceWrite — delta vs existing (launch mode, N=1)', () => {
  // In launch mode, delta check is bypassed entirely so we can build the initial DB
  test('accepts massive OCR-disaster delta when N=1 (no existing scans to corroborate against yet)', () => {
    // $5.79 → $57.99 (901% delta) — without corroboration enabled, nothing to compare
    expect(validatePriceWrite(baseInput({
      price: 57.99,
      existingMarketPrice: { price: 5.79 },
    })).decision).toBe('accept');
  });

  test('accepts small delta when N=1', () => {
    expect(validatePriceWrite(baseInput({
      price: 5.99,
      existingMarketPrice: { price: 5.79 },
    })).decision).toBe('accept');
  });
});

describe('validatePriceWrite — delta vs existing (post-launch, N=2)', () => {
  const config = { minCorroboratingScans: 2 };

  test('quarantines $5.79 → $57.99 OCR disaster (901% delta)', () => {
    expect(validatePriceWrite(baseInput({
      price: 57.99,
      existingMarketPrice: { price: 5.79 },
    }), config))
      .toEqual({ decision: 'quarantine', reason: 'awaiting_corroboration' });
  });

  test('accepts 3% delta ($5.79 → $5.99)', () => {
    expect(validatePriceWrite(baseInput({
      price: 5.99,
      existingMarketPrice: { price: 5.79 },
    }), config).decision).toBe('accept');
  });

  test('accepts 50% delta exactly (boundary, > vs >=)', () => {
    // delta = 0.50 exactly — code uses strict > so this is accept
    expect(validatePriceWrite(baseInput({
      price: 6.00,
      existingMarketPrice: { price: 4.00 },
    }), config).decision).toBe('accept');
  });

  test('quarantines just-over-50% delta', () => {
    expect(validatePriceWrite(baseInput({
      price: 6.01,
      existingMarketPrice: { price: 4.00 },
    }), config))
      .toEqual({ decision: 'quarantine', reason: 'awaiting_corroboration' });
  });

  test('accepts large delta when no existing market price (first scan in zone)', () => {
    expect(validatePriceWrite(baseInput({
      price: 57.99,
      existingMarketPrice: null,
    }), config).decision).toBe('accept');
  });

  test('accepts large delta when existing price is 0/missing (defensive)', () => {
    expect(validatePriceWrite(baseInput({
      price: 5.79,
      existingMarketPrice: { price: 0 },
    }), config).decision).toBe('accept');
  });
});

describe('validatePriceWrite — combined: bounds beats confidence beats delta', () => {
  test('bounds violation reported even when confidence and delta would also fail', () => {
    expect(validatePriceWrite(baseInput({
      price: 9999,
      confidence: 0.1,
      existingMarketPrice: { price: 5.79 },
    })))
      .toEqual({ decision: 'reject', reason: 'bounds_violation' });
  });

  test('low_confidence reported before delta when both would trip (N=2)', () => {
    expect(validatePriceWrite(baseInput({
      price: 57.99,
      confidence: 0.5,
      existingMarketPrice: { price: 5.79 },
    }), { minCorroboratingScans: 2 }))
      .toEqual({ decision: 'quarantine', reason: 'low_confidence' });
  });
});
