// src/__tests__/recommendations.integration.test.js
// ============================================================
// Integration tests for the Recommend-a-Store pipeline.
//
// Mocks at the pg.Pool level — NOT at the query() helper. This means
// the real db.js wrapper runs (timing logs, error handling), the
// real recommendationService runs (cache, helpers, all 3 tiers),
// and the real driveTimeService runs (cache table reads, batched DM
// fallback). The only fake surface is the SQL responses, set per-test
// via pool.query.mockResolvedValueOnce(...).
//
// Per-file unit tests already lock individual SQL shapes and helper
// math. These integration tests cover what the unit tests cannot —
// the orchestration: gate ordering, route→service→cache composition,
// cache invalidation on list_version bump, and zero-work guarantees
// across the full request lifecycle.
// ============================================================

jest.mock('pg', () => {
  const mPool = {
    query: jest.fn(),
    connect: jest.fn(),
    on: jest.fn(),
  };
  return { Pool: jest.fn(() => mPool) };
});

jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

const express = require('express');
const http = require('http');
const { Pool } = require('pg');
const recommendationsRoute = require('../routes/recommendations');
const recommendationService = require('../services/recommendationService');

const pool = new Pool();

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/recommendations', recommendationsRoute);
  return app;
}

async function getJson(app, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch (e) { reject(e); }
        });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

// Helper to enqueue a "happy path" engine pipeline for ONE candidate
// store with one matched item (Tier 1).
function enqueueEnginePipeline({ storeId = 'S1', listVersion = 1, defaultStoreId = null } = {}) {
  pool.query
    // 1. recommendationService: list + items
    .mockResolvedValueOnce({ rows: [{ id: 'L1', list_version: listVersion, items: [{ id: 'i1', name: 'milk', quantity: 1 }] }] })
    // 2. getCandidateStores (Haversine)
    .mockResolvedValueOnce({ rows: [{ id: storeId, name: 'Foo', address: 'a', latitude: '40', longitude: '-74', distance_km: '1' }] })
    // 3. _buildReferenceUnitPrices
    .mockResolvedValueOnce({ rows: [{ k: 'milk', ref: '4.99' }] })
    // 4. matchItemAtStore Tier 1 hit
    .mockResolvedValueOnce({
      rows: [{ price: '4.99', unit_price: '4.99', confidence: 0.9, updated_at: new Date(), product_name: 'Milk', barcode: 'b1' }],
    })
    // 5. driveTimeService.getDriveTimes — cache lookup hit
    .mockResolvedValueOnce({ rows: [{ duration_seconds: 600, distance_meters: 5000, cached_at: new Date() }] })
    // 6. _resolveMode: SELECT default_store_id
    .mockResolvedValueOnce({ rows: [{ default_store_id: defaultStoreId }] });
}

beforeEach(() => {
  pool.query.mockReset();
  recommendationService.clearCache();
});

const URL_OK = '/api/recommendations/where-to-shop?list_id=L1&lat=40&lng=-74';

// ── Integration A: gate ordering with zero downstream work ─
describe('integration: gate ordering and zero-work guarantees', () => {
  test('opted-out user: route → consent gate → STOP (no allergen, no engine)', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: null, user_allergen_count: 0, user_dietary_count: 0, family_restriction_count: 0 }],
    });
    const res = await getJson(buildApp(), URL_OK);
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('user_not_opted_in');
    // ZERO additional queries beyond the gate-state lookup
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('allergen-blocked user: consent passes → allergen gate fires → STOP', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: true, user_allergen_count: 1, user_dietary_count: 0, family_restriction_count: 0 }],
    });
    const res = await getJson(buildApp(), URL_OK);
    expect(res.body.reason).toBe('allergen_safety_unavailable');
    expect(res.body.actions).toEqual(['disable_allergen_tracking', 'wait']);
    expect(pool.query).toHaveBeenCalledTimes(1); // still no engine queries
  });

  test('clean user: consent + allergen pass → engine runs end-to-end', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: true, user_allergen_count: 0, user_dietary_count: 0, family_restriction_count: 0 }],
    });
    enqueueEnginePipeline();
    const res = await getJson(buildApp(), URL_OK);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.blocked).toBe(false);
    expect(res.body.mode).toBe('A'); // no default_store_id → mode A
    expect(res.body.preferred.store_id).toBe('S1');
    // Gate-state + 6 engine queries = 7 total
    expect(pool.query).toHaveBeenCalledTimes(7);
  });
});

// ── Integration B: cache hit/miss + list_version invalidation ─
describe('integration: recommendationService cache through the route', () => {
  function enqueueGate() {
    pool.query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: true, user_allergen_count: 0, user_dietary_count: 0, family_restriction_count: 0 }],
    });
  }

  test('cache HIT: same list_version → second call avoids stores/match/DM/mode queries', async () => {
    // First call: full pipeline
    enqueueGate();
    enqueueEnginePipeline({ listVersion: 5 });
    const first = await getJson(buildApp(), URL_OK);
    expect(first.body.cache_hit).toBe(false);
    const queriesAfterFirst = pool.query.mock.calls.length;

    // Second call: gate state (1) + service list+version lookup (1) = +2 only.
    enqueueGate();
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'L1', list_version: 5, items: [{ id: 'i1', name: 'milk', quantity: 1 }] }],
    });
    const second = await getJson(buildApp(), URL_OK);
    expect(second.body.cache_hit).toBe(true);
    expect(pool.query.mock.calls.length).toBe(queriesAfterFirst + 2);
  });

  test('cache MISS: list_version bump invalidates and triggers full pipeline again', async () => {
    enqueueGate();
    enqueueEnginePipeline({ listVersion: 5 });
    const first = await getJson(buildApp(), URL_OK);
    expect(first.body.cache_hit).toBe(false);

    // Same user, same list, but list_version bumped to 6 → cache key changes.
    enqueueGate();
    enqueueEnginePipeline({ listVersion: 6 });
    const second = await getJson(buildApp(), URL_OK);
    expect(second.body.cache_hit).toBe(false);
    expect(second.body.list_version).toBe(6);
  });
});

// ── Integration C: mode resolution end-to-end ─────────────
describe('integration: mode A/B/C resolution through the full pipeline', () => {
  function enqueueGate() {
    pool.query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: true, user_allergen_count: 0, user_dietary_count: 0, family_restriction_count: 0 }],
    });
  }

  function enqueueTwoStorePipeline({ defaultStoreId = null, s1Price = '5.99', s2Price = '3.99' } = {}) {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'L1', list_version: 1, items: [{ id: 'i1', name: 'milk', quantity: 1 }] }] })
      .mockResolvedValueOnce({ rows: [
        { id: 'S1', name: 'Default', address: 'a', latitude: '40',   longitude: '-74',   distance_km: '1' },
        { id: 'S2', name: 'Cheap',   address: 'b', latitude: '40.1', longitude: '-74.1', distance_km: '2' },
      ] })
      .mockResolvedValueOnce({ rows: [{ k: 'milk', ref: '4.99' }] })
      .mockResolvedValueOnce({ rows: [{ price: s1Price, unit_price: s1Price, confidence: 0.9, updated_at: new Date(), product_name: 'Milk', barcode: 'b1' }] })
      .mockResolvedValueOnce({ rows: [{ price: s2Price, unit_price: s2Price, confidence: 0.9, updated_at: new Date(), product_name: 'Milk', barcode: 'b1' }] })
      // driveTime cache lookups for two stores (parallel) — both hit
      .mockResolvedValueOnce({ rows: [{ duration_seconds: 300, distance_meters: 1000, cached_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [{ duration_seconds: 600, distance_meters: 2000, cached_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [{ default_store_id: defaultStoreId }] });
  }

  test('Mode A: no default → cheapest is preferred, second cheapest is alternative', async () => {
    enqueueGate();
    enqueueTwoStorePipeline({ defaultStoreId: null });
    const res = await getJson(buildApp(), URL_OK);
    expect(res.body.mode).toBe('A');
    expect(res.body.preferred.store_id).toBe('S2');
    expect(res.body.alternative.store_id).toBe('S1');
  });

  test('Mode B: default IS the cheapest → silent (preferred = default)', async () => {
    enqueueGate();
    // Make S1 (default) the cheaper one
    enqueueTwoStorePipeline({ defaultStoreId: 'S1', s1Price: '3.99', s2Price: '5.99' });
    const res = await getJson(buildApp(), URL_OK);
    expect(res.body.mode).toBe('B');
    expect(res.body.preferred.store_id).toBe('S1');
  });

  test('Mode C: default beaten → preferred = default, alternative = cheaper one', async () => {
    enqueueGate();
    enqueueTwoStorePipeline({ defaultStoreId: 'S1', s1Price: '5.99', s2Price: '3.99' });
    const res = await getJson(buildApp(), URL_OK);
    expect(res.body.mode).toBe('C');
    expect(res.body.preferred.store_id).toBe('S1');
    expect(res.body.alternative.store_id).toBe('S2');
  });
});

// ── Integration D: banner trigger across pipeline ─────────
describe('integration: banner trigger evaluation through route', () => {
  function enqueueGate() {
    pool.query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: true, user_allergen_count: 0, user_dietary_count: 0, family_restriction_count: 0 }],
    });
  }

  test('savings >= $10 with comparable drive → banner trigger=true', async () => {
    enqueueGate();
    pool.query
      // Two items so basket is large enough for a $10+ savings on price diff
      .mockResolvedValueOnce({ rows: [{ id: 'L1', list_version: 1, items: [
        { id: 'i1', name: 'milk',  quantity: 5 },
        { id: 'i2', name: 'bread', quantity: 5 },
      ] }] })
      .mockResolvedValueOnce({ rows: [
        { id: 'S1', name: 'Default', address: 'a', latitude: '40',   longitude: '-74',   distance_km: '1' },
        { id: 'S2', name: 'Cheap',   address: 'b', latitude: '40.1', longitude: '-74.1', distance_km: '2' },
      ] })
      .mockResolvedValueOnce({ rows: [{ k: 'milk', ref: '4.99' }, { k: 'bread', ref: '4.99' }] })
      // priceBasketAtStore runs in Promise.all → microtask interleaving
      // means the per-item match queries fire in order:
      //   (S1, milk) → (S2, milk) → (S1, bread) → (S2, bread)
      // NOT all S1 then all S2. Mock order matches actual call order.
      .mockResolvedValueOnce({ rows: [{ price: '5.99', unit_price: '5.99', confidence: 0.9, updated_at: new Date(), product_name: 'Milk',  barcode: 'b1' }] }) // S1 milk
      .mockResolvedValueOnce({ rows: [{ price: '3.99', unit_price: '3.99', confidence: 0.9, updated_at: new Date(), product_name: 'Milk',  barcode: 'b1' }] }) // S2 milk
      .mockResolvedValueOnce({ rows: [{ price: '5.99', unit_price: '5.99', confidence: 0.9, updated_at: new Date(), product_name: 'Bread', barcode: 'b2' }] }) // S1 bread
      .mockResolvedValueOnce({ rows: [{ price: '3.99', unit_price: '3.99', confidence: 0.9, updated_at: new Date(), product_name: 'Bread', barcode: 'b2' }] }) // S2 bread
      // drive-time cache for both
      .mockResolvedValueOnce({ rows: [{ duration_seconds: 300, distance_meters: 1000, cached_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [{ duration_seconds: 360, distance_meters: 1500, cached_at: new Date() }] })
      // Default = S1 → mode C, banner can fire
      .mockResolvedValueOnce({ rows: [{ default_store_id: 'S1' }] });

    const res = await getJson(buildApp(), URL_OK);
    expect(res.body.mode).toBe('C');
    // Basket diff: ($5.99-$3.99) * 5 * 2 = $20 > $10 floor; drive 5 vs 6 min ok
    expect(res.body.preferred.total_cost).toBe(59.9);
    expect(res.body.alternative.total_cost).toBe(39.9);
    expect(res.body.banner.trigger).toBe(true);
    expect(res.body.banner.savings).toBeCloseTo(20, 1);
  });
});

// ── Integration E: input validation surfaces through the route ─
describe('integration: route-level validation', () => {
  test('missing list_id: 400, no DB queries at all', async () => {
    const res = await getJson(buildApp(), '/api/recommendations/where-to-shop?lat=40&lng=-74');
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('missing lat/lng: 400, no DB queries at all', async () => {
    const res = await getJson(buildApp(), '/api/recommendations/where-to-shop?list_id=L1');
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
