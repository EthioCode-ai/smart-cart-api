// src/services/recommendationService.test.js
// ============================================================
// Behavior tests for recommendationService.
// Locks in: 3-tier match logic, gate constants, basket aggregation,
// cache key shape, banner trigger thresholds, mode resolution.
// driveTimeService and db.query are both mocked.
// ============================================================

jest.mock('../models/db', () => ({ query: jest.fn() }));
jest.mock('./driveTimeService', () => ({
  getDriveTimes: jest.fn(),
}));

const { query } = require('../models/db');
const driveTimeService = require('./driveTimeService');
const svc = require('./recommendationService');

beforeEach(() => {
  query.mockReset();
  driveTimeService.getDriveTimes.mockReset();
  svc.clearCache();
});

// ── Pure helpers ──────────────────────────────────────────
describe('_normalizePacs', () => {
  test('NULL → 0.39 (just below PACS gate, gates legacy rows out by default)', () => {
    expect(svc._normalizePacs(null)).toBe(0.39);
    expect(svc._normalizePacs(undefined)).toBe(0.39);
    expect(svc._normalizePacs(null)).toBeLessThan(svc.PACS_GATE);
  });
  test('0–1 stays as-is', () => {
    expect(svc._normalizePacs(0.7)).toBe(0.7);
  });
  test('0–100 normalized to 0–1', () => {
    expect(svc._normalizePacs(85)).toBeCloseTo(0.85, 5);
  });
  test('non-numeric → 0.39', () => {
    expect(svc._normalizePacs('not a number')).toBe(0.39);
  });
});

describe('_recencyDecay', () => {
  test('today → ~1.0', () => {
    expect(svc._recencyDecay(new Date())).toBeCloseTo(1, 1);
  });
  test('30 days ago → ~exp(-1)', () => {
    const d = new Date(Date.now() - 30 * 86400000);
    expect(svc._recencyDecay(d)).toBeCloseTo(Math.exp(-1), 2);
  });
  test('null updatedAt → 0.5', () => {
    expect(svc._recencyDecay(null)).toBe(0.5);
  });
});

describe('_substitutionScore', () => {
  test('higher similarity wins when other factors equal', () => {
    const a = svc._substitutionScore({ similarity: 0.9, pacs: 0.8, scanCount: 1, updatedAt: new Date() });
    const b = svc._substitutionScore({ similarity: 0.7, pacs: 0.8, scanCount: 1, updatedAt: new Date() });
    expect(a).toBeGreaterThan(b);
  });
  test('higher PACS wins when other factors equal', () => {
    const a = svc._substitutionScore({ similarity: 0.8, pacs: 0.9, scanCount: 1, updatedAt: new Date() });
    const b = svc._substitutionScore({ similarity: 0.8, pacs: 0.5, scanCount: 1, updatedAt: new Date() });
    expect(a).toBeGreaterThan(b);
  });
  test('older row scored lower', () => {
    const fresh = svc._substitutionScore({ similarity: 0.8, pacs: 0.8, scanCount: 1, updatedAt: new Date() });
    const stale = svc._substitutionScore({ similarity: 0.8, pacs: 0.8, scanCount: 1, updatedAt: new Date(Date.now() - 60 * 86400000) });
    expect(fresh).toBeGreaterThan(stale);
  });
  test('scan_count meaningfully differentiates: 50x corroboration beats 1x fluke', () => {
    // sim/pacs/recency held equal; only scan_count differs.
    const fluke   = svc._substitutionScore({ similarity: 0.9, pacs: 0.9, scanCount: 1,  updatedAt: new Date() });
    const proven  = svc._substitutionScore({ similarity: 0.9, pacs: 0.9, scanCount: 50, updatedAt: new Date() });
    expect(proven).toBeGreaterThan(fluke);
    // log10(60)/log10(11) ≈ 1.71 — should be ~70% higher
    expect(proven / fluke).toBeGreaterThan(1.6);
  });
});

// ── Constants ────────────────────────────────────────────
describe('exposed constants', () => {
  test('match the spec values', () => {
    expect(svc.STALENESS_DAYS).toBe(45);
    expect(svc.PACS_GATE).toBe(0.40);
    expect(svc.TRIGRAM_THRESHOLD).toBe(0.7);
    expect(svc.PRICE_BAND_FACTOR).toBe(0.30);
    expect(svc.CACHE_TTL_MS).toBe(15 * 60 * 1000);
  });
});

// ── matchItemAtStore: 3-tier ──────────────────────────────
describe('matchItemAtStore', () => {
  test('Tier 1: exact name match short-circuits', async () => {
    query.mockResolvedValueOnce({
      rows: [{ price: '4.99', unit_price: '4.99', confidence: 0.9, updated_at: new Date(), product_name: 'Whole Milk', barcode: 'b1' }],
    });
    const m = await svc.matchItemAtStore({ item: { name: 'whole milk' }, storeId: 'S1' });
    expect(m).toMatchObject({ matched: true, tier: 1, source: 'exact_name', price: 4.99, name_used: 'Whole Milk' });
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/LOWER\(p\.name\) = \$2/);
    expect(sql).toMatch(/INTERVAL '45 days'/);
  });

  test('Tier 2: barcode match when Tier 1 misses and item has barcode', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // T1 miss
    query.mockResolvedValueOnce({
      rows: [{ price: '3.49', unit_price: null, confidence: 0.7, updated_at: new Date(), product_name: 'Eggs Dozen' }],
    });
    const m = await svc.matchItemAtStore({ item: { name: 'large eggs', barcode: '0123456' }, storeId: 'S1' });
    expect(m).toMatchObject({ matched: true, tier: 2, source: 'barcode', price: 3.49 });
    expect(query.mock.calls[1][0]).toMatch(/sp\.barcode = \$1/);
  });

  test('Tier 3: trigram match passes when sim>0.7 + PACS>=0.4', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // T1 miss
    // No barcode, so T2 not called
    query.mockResolvedValueOnce({
      rows: [
        { price: '5.99', unit_price: '5.99', confidence: 0.8, updated_at: new Date(),
          product_name: 'Organic Whole Milk', sim: '0.82', scan_count: '12' },
      ],
    });
    const m = await svc.matchItemAtStore({ item: { name: 'whole milk' }, storeId: 'S1' });
    expect(m).toMatchObject({ matched: true, tier: 3, source: 'substitute' });
    expect(m.substitute).toMatchObject({ from: 'whole milk', to: 'Organic Whole Milk' });
  });

  test('Tier 3: SQL LEFT JOINs market_prices for scan_count', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // T1 miss
    query.mockResolvedValueOnce({ rows: [] }); // T3 returns nothing — we just lock in the SQL shape
    await svc.matchItemAtStore({ item: { name: 'milk' }, storeId: 'S1' });
    const t3sql = query.mock.calls[1][0];
    expect(t3sql).toMatch(/LEFT JOIN market_prices mp/);
    expect(t3sql).toMatch(/COALESCE\(mp\.scan_count, 1\)/);
  });

  test('Tier 3: NULL confidence is gated out by default (NULL → 0.39 < 0.40)', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // T1 miss
    query.mockResolvedValueOnce({
      rows: [
        { price: '5.99', unit_price: '5.99', confidence: null, updated_at: new Date(),
          product_name: 'Generic', sim: '0.82', scan_count: '5' },
      ],
    });
    const m = await svc.matchItemAtStore({ item: { name: 'milk' }, storeId: 'S1' });
    expect(m).toEqual({ matched: false });
  });

  test('Tier 3: PACS gate excludes low-confidence rows', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // T1 miss
    query.mockResolvedValueOnce({
      rows: [
        { price: '5.99', unit_price: '5.99', confidence: 0.2, updated_at: new Date(),
          product_name: 'Organic Whole Milk', sim: '0.82' },
      ],
    });
    const m = await svc.matchItemAtStore({ item: { name: 'whole milk' }, storeId: 'S1' });
    expect(m).toEqual({ matched: false });
  });

  test('Tier 3: ±30% price band excludes outliers when reference provided', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // T1 miss
    query.mockResolvedValueOnce({
      rows: [
        { price: '20.00', unit_price: '20.00', confidence: 0.9, updated_at: new Date(),
          product_name: 'Truffle Salt', sim: '0.75' },
      ],
    });
    const m = await svc.matchItemAtStore({
      item: { name: 'salt' },
      storeId: 'S1',
      referenceUnitPrice: 2.0, // band: 1.40–2.60; $20 is way out
    });
    expect(m).toEqual({ matched: false });
  });

  test('Tier 3 picks highest-score candidate', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // T1 miss
    const now = new Date();
    query.mockResolvedValueOnce({
      rows: [
        { price: '4.50', unit_price: '4.50', confidence: 0.5, updated_at: now,
          product_name: 'A', sim: '0.71' },
        { price: '4.80', unit_price: '4.80', confidence: 0.9, updated_at: now,
          product_name: 'B', sim: '0.85' },
        { price: '4.20', unit_price: '4.20', confidence: 0.6, updated_at: now,
          product_name: 'C', sim: '0.72' },
      ],
    });
    const m = await svc.matchItemAtStore({ item: { name: 'whole milk' }, storeId: 'S1' });
    expect(m.matched).toBe(true);
    expect(m.name_used).toBe('B'); // highest sim*pacs
  });

  test('returns matched:false for empty item name with no barcode', async () => {
    const m = await svc.matchItemAtStore({ item: { name: '' }, storeId: 'S1' });
    expect(m).toEqual({ matched: false });
    expect(query).not.toHaveBeenCalled();
  });
});

// ── reference-price discovery (median) ────────────────────
describe('reference unit price (used for ±30% band)', () => {
  test('SQL uses PERCENTILE_CONT(0.5) median, not MIN', async () => {
    // Internal helper not directly exported; observe SQL through the
    // priceBasketAtStore-level call path. Here we exercise it via the
    // full getRecommendations pipeline up to the ref-prices query.
    query.mockResolvedValueOnce({ rows: [{ id: 'L1', list_version: 1, items: [{ id: 'i1', name: 'milk', quantity: 1 }] }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'S1', name: 'Foo', address: 'a', latitude: '40', longitude: '-74', distance_km: '1' }] });
    query.mockResolvedValueOnce({ rows: [{ k: 'milk', ref: '4.99' }] }); // ref prices
    query.mockResolvedValueOnce({ rows: [] }); // T1 miss
    query.mockResolvedValueOnce({ rows: [] }); // T3 empty
    driveTimeService.getDriveTimes.mockResolvedValueOnce([{ store_id: 'S1', duration_seconds: 600, distance_meters: 5000, cache_hit: false }]);
    query.mockResolvedValueOnce({ rows: [{ default_store_id: null }] });

    await svc.getRecommendations({ userId: 'u', listId: 'L1', userLat: 40, userLng: -74 });

    const refSql = query.mock.calls[2][0];
    expect(refSql).toMatch(/PERCENTILE_CONT\(0\.5\)/);
    expect(refSql).not.toMatch(/MIN\(sp\.unit_price\)/);
  });
});

// ── getCandidateStores ────────────────────────────────────
describe('getCandidateStores', () => {
  test('emits Haversine SQL with radius/limit and parses lat/lng', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { id: 'S1', name: 'Foo', address: 'addr', latitude: '40.7', longitude: '-74.0', distance_km: '1.2' },
        { id: 'S2', name: 'Bar', address: 'addr2', latitude: '40.75', longitude: '-74.05', distance_km: '2.0' },
      ],
    });
    const stores = await svc.getCandidateStores({ userLat: 40.71, userLng: -74.0, radiusKm: 8, limit: 5 });
    expect(stores).toHaveLength(2);
    expect(stores[0]).toMatchObject({ id: 'S1', lat: 40.7, lng: -74.0, distance_km: 1.2 });
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/6371 \* acos/);
    expect(query.mock.calls[0][1]).toEqual([40.71, -74.0, 8, 5]);
  });

  test('returns [] when lat/lng not provided', async () => {
    const stores = await svc.getCandidateStores({ userLat: null, userLng: null });
    expect(stores).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

// ── evaluateBannerTrigger ─────────────────────────────────
describe('evaluateBannerTrigger', () => {
  const baseStore = (id, cost, drive) => ({
    store_id: id, total_cost: cost, drive_minutes: drive,
  });

  test('savings >= $10 + drive ratio OK → trigger', () => {
    const r = svc.evaluateBannerTrigger({
      preferred: baseStore('A', 100, 10),
      alternative: baseStore('B', 88, 15),
    });
    expect(r.trigger).toBe(true);
    expect(r.savings).toBe(12);
  });

  test('savings < $10 AND < 10% → no trigger', () => {
    const r = svc.evaluateBannerTrigger({
      preferred: baseStore('A', 50, 10),
      alternative: baseStore('B', 45, 12), // $5 savings, 10% — borderline
    });
    expect(r.trigger).toBe(false);
  });

  test('savings >= 10% of basket overrides $10 floor', () => {
    const r = svc.evaluateBannerTrigger({
      preferred: baseStore('A', 200, 10),
      alternative: baseStore('B', 178, 12), // $22 savings = 11% > 10%
    });
    expect(r.trigger).toBe(true);
  });

  test('alt drive > 2x preferred AND > +5min absolute → no trigger', () => {
    const r = svc.evaluateBannerTrigger({
      preferred: baseStore('A', 100, 10),
      alternative: baseStore('B', 80, 25), // savings $20, but 25 > 20 (2x) AND 25-10=15 > 5
    });
    expect(r.trigger).toBe(false);
  });

  test('alt drive within +5min absolute (even if > 2x) → trigger', () => {
    const r = svc.evaluateBannerTrigger({
      preferred: baseStore('A', 100, 2),
      alternative: baseStore('B', 80, 6), // 6 > 2*2=4 fails ratio, but 6-2=4 <= 5 ok
    });
    expect(r.trigger).toBe(true);
  });

  test('drive minutes missing → trigger evaluated by savings only', () => {
    const r = svc.evaluateBannerTrigger({
      preferred: { ...baseStore('A', 100), drive_minutes: null },
      alternative: { ...baseStore('B', 80), drive_minutes: null },
    });
    expect(r.trigger).toBe(true);
    expect(r.drive_minutes_extra).toBeNull();
  });
});

// ── getRecommendations end-to-end ─────────────────────────
describe('getRecommendations', () => {
  test('throws when userId missing', async () => {
    await expect(svc.getRecommendations({ listId: 'L1' })).rejects.toThrow(/userId/);
  });

  test('throws when listId missing', async () => {
    await expect(svc.getRecommendations({ userId: 'u' })).rejects.toThrow(/listId/);
  });

  test('list not found → throws', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(svc.getRecommendations({ userId: 'u', listId: 'missing' })).rejects.toThrow(/list not found/);
  });

  test('empty_list when list exists with zero items', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'L1', list_version: 0, items: [] }] });
    // Haversine for stores
    query.mockResolvedValueOnce({
      rows: [{ id: 'S1', name: 'Foo', address: 'a', latitude: '40', longitude: '-74', distance_km: '1' }],
    });
    const r = await svc.getRecommendations({ userId: 'u', listId: 'L1', userLat: 40, userLng: -74 });
    expect(r.mode).toBe('empty');
    expect(r.reason).toBe('empty_list');
  });

  test('no_nearby_stores when Haversine returns nothing', async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 'L1', list_version: 5, items: [{ id: 'i1', name: 'milk', quantity: 1 }] }],
    });
    query.mockResolvedValueOnce({ rows: [] }); // no candidate stores
    const r = await svc.getRecommendations({ userId: 'u', listId: 'L1', userLat: 40, userLng: -74 });
    expect(r.mode).toBe('empty');
    expect(r.reason).toBe('no_nearby_stores');
    expect(r.list_version).toBe(5);
  });

  test('caches results and returns cache_hit on second call', async () => {
    // 1st call: full pipeline (6 queries: list, stores, refPrices, T1, user.default_store_id; T1 + 0 because we have 1 store)
    query.mockResolvedValueOnce({ rows: [{ id: 'L1', list_version: 5, items: [{ id: 'i1', name: 'milk', quantity: 1 }] }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'S1', name: 'Foo', address: 'a', latitude: '40', longitude: '-74', distance_km: '1' }] });
    query.mockResolvedValueOnce({ rows: [] }); // ref unit prices
    query.mockResolvedValueOnce({ rows: [{ price: '4.99', unit_price: '4.99', confidence: 0.9, updated_at: new Date(), product_name: 'Milk' }] }); // T1 hit
    driveTimeService.getDriveTimes.mockResolvedValueOnce([{ store_id: 'S1', duration_seconds: 600, distance_meters: 5000, cache_hit: false }]);
    query.mockResolvedValueOnce({ rows: [{ default_store_id: null }] }); // user has no default → mode A

    const first = await svc.getRecommendations({ userId: 'u', listId: 'L1', userLat: 40, userLng: -74 });
    expect(first.cache_hit).toBe(false);
    expect(first.mode).toBe('A');
    expect(first.preferred.store_id).toBe('S1');

    const beforeCalls = query.mock.calls.length;
    const dmBefore = driveTimeService.getDriveTimes.mock.calls.length;
    // 2nd call: cache hit short-circuits AFTER the list+version lookup, so
    // exactly +1 query and no additional DM calls.
    query.mockResolvedValueOnce({ rows: [{ id: 'L1', list_version: 5, items: [{ id: 'i1', name: 'milk', quantity: 1 }] }] });

    const second = await svc.getRecommendations({ userId: 'u', listId: 'L1', userLat: 40, userLng: -74 });
    expect(second.cache_hit).toBe(true);
    expect(query.mock.calls.length).toBe(beforeCalls + 1);
    expect(driveTimeService.getDriveTimes.mock.calls.length).toBe(dmBefore);
  });

  test('Mode B: user has default and it is cheapest → silent', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'L1', list_version: 1, items: [{ id: 'i1', name: 'milk', quantity: 1 }] }] });
    query.mockResolvedValueOnce({
      rows: [
        { id: 'S1', name: 'Default', address: 'a', latitude: '40', longitude: '-74', distance_km: '1' },
        { id: 'S2', name: 'Other',   address: 'b', latitude: '40.1', longitude: '-74.1', distance_km: '2' },
      ],
    });
    query.mockResolvedValueOnce({ rows: [] }); // ref prices
    query.mockResolvedValueOnce({ rows: [{ price: '3.99', unit_price: '3.99', confidence: 0.9, updated_at: new Date(), product_name: 'Milk' }] }); // S1 T1
    query.mockResolvedValueOnce({ rows: [{ price: '5.99', unit_price: '5.99', confidence: 0.9, updated_at: new Date(), product_name: 'Milk' }] }); // S2 T1
    driveTimeService.getDriveTimes.mockResolvedValueOnce([
      { store_id: 'S1', duration_seconds: 300, distance_meters: 1000, cache_hit: true },
      { store_id: 'S2', duration_seconds: 600, distance_meters: 2000, cache_hit: true },
    ]);
    query.mockResolvedValueOnce({ rows: [{ default_store_id: 'S1' }] });

    const r = await svc.getRecommendations({ userId: 'u', listId: 'L1', userLat: 40, userLng: -74 });
    expect(r.mode).toBe('B');
    expect(r.preferred.store_id).toBe('S1');
  });

  test('Mode C: user has default but alternative is cheaper', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'L1', list_version: 1, items: [{ id: 'i1', name: 'milk', quantity: 1 }] }] });
    query.mockResolvedValueOnce({
      rows: [
        { id: 'S1', name: 'Default', address: 'a', latitude: '40', longitude: '-74', distance_km: '1' },
        { id: 'S2', name: 'Cheap',   address: 'b', latitude: '40.1', longitude: '-74.1', distance_km: '2' },
      ],
    });
    query.mockResolvedValueOnce({ rows: [] }); // ref prices
    query.mockResolvedValueOnce({ rows: [{ price: '5.99', unit_price: '5.99', confidence: 0.9, updated_at: new Date(), product_name: 'Milk' }] });
    query.mockResolvedValueOnce({ rows: [{ price: '3.99', unit_price: '3.99', confidence: 0.9, updated_at: new Date(), product_name: 'Milk' }] });
    driveTimeService.getDriveTimes.mockResolvedValueOnce([
      { store_id: 'S1', duration_seconds: 300, distance_meters: 1000, cache_hit: true },
      { store_id: 'S2', duration_seconds: 600, distance_meters: 2000, cache_hit: true },
    ]);
    query.mockResolvedValueOnce({ rows: [{ default_store_id: 'S1' }] });

    const r = await svc.getRecommendations({ userId: 'u', listId: 'L1', userLat: 40, userLng: -74 });
    expect(r.mode).toBe('C');
    expect(r.preferred.store_id).toBe('S1');
    expect(r.alternative.store_id).toBe('S2');
  });
});
