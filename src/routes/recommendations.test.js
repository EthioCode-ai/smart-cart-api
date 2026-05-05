// src/routes/recommendations.test.js
// ============================================================
// Behavior tests for GET /api/recommendations/where-to-shop.
// Mocks the recommendationService and exercises the gate ordering
// (consent → allergen → engine) via real express dispatch.
// ============================================================

jest.mock('../models/db', () => {
  const actual = jest.requireActual('../models/db');
  return {
    ...actual,
    query: jest.fn(),
    successResponse: (res, data, status = 200) => res.status(status).json(data),
    errorResponse: (res, status, message) => res.status(status).json({ error: message }),
  };
});

jest.mock('../services/recommendationService', () => ({
  getRecommendations: jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

const express = require('express');
const http = require('http');
const { query } = require('../models/db');
const recommendationService = require('../services/recommendationService');
const router = require('./recommendations');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/recommendations', router);
  return app;
}

async function getJson(app, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch (e) { reject(e); }
        });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

beforeEach(() => {
  query.mockReset();
  recommendationService.getRecommendations.mockReset();
});

const URL_OK = '/api/recommendations/where-to-shop?list_id=L1&lat=40&lng=-74';

describe('GET /api/recommendations/where-to-shop — input validation', () => {
  test('400 when list_id missing', async () => {
    const res = await getJson(buildApp(), '/api/recommendations/where-to-shop?lat=40&lng=-74');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/list_id/);
    expect(query).not.toHaveBeenCalled();
  });

  test('400 when lat/lng missing', async () => {
    const res = await getJson(buildApp(), '/api/recommendations/where-to-shop?list_id=L1');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lat/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GATE 1 — consent', () => {
  test('user_settings missing entirely → user_not_opted_in', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // no user_settings row
    const res = await getJson(buildApp(), URL_OK);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, reason: 'user_not_opted_in' });
    expect(recommendationService.getRecommendations).not.toHaveBeenCalled();
  });

  test('recommend_stores_enabled = NULL → user_not_opted_in', async () => {
    query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: null, user_allergen_count: 0, user_dietary_count: 0, family_restriction_count: 0 }],
    });
    const res = await getJson(buildApp(), URL_OK);
    expect(res.body).toEqual({ enabled: false, reason: 'user_not_opted_in' });
    expect(recommendationService.getRecommendations).not.toHaveBeenCalled();
  });

  test('recommend_stores_enabled = false → user_not_opted_in', async () => {
    query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: false, user_allergen_count: 0, user_dietary_count: 0, family_restriction_count: 0 }],
    });
    const res = await getJson(buildApp(), URL_OK);
    expect(res.body).toEqual({ enabled: false, reason: 'user_not_opted_in' });
    expect(recommendationService.getRecommendations).not.toHaveBeenCalled();
  });

  test('consent gate fires before allergen gate (no allergen check on opted-out users)', async () => {
    query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: false, user_allergen_count: 5, user_dietary_count: 2, family_restriction_count: 3 }],
    });
    const res = await getJson(buildApp(), URL_OK);
    // Even with non-zero counts, the response is consent-gated, not allergen-gated.
    expect(res.body.reason).toBe('user_not_opted_in');
  });
});

describe('GATE 2 — allergen safety', () => {
  test('user has user_settings.allergens populated → allergen_safety_unavailable', async () => {
    query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: true, user_allergen_count: 2, user_dietary_count: 0, family_restriction_count: 0 }],
    });
    const res = await getJson(buildApp(), URL_OK);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      blocked: true,
      reason: 'allergen_safety_unavailable',
      message: "Allergen filtering is coming in our next update — until then we can't safely recommend stores for households with allergens recorded.",
      actions: ['disable_allergen_tracking', 'wait'],
    });
    expect(recommendationService.getRecommendations).not.toHaveBeenCalled();
  });

  test('user has dietary_restrictions populated → allergen_safety_unavailable', async () => {
    query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: true, user_allergen_count: 0, user_dietary_count: 3, family_restriction_count: 0 }],
    });
    const res = await getJson(buildApp(), URL_OK);
    expect(res.body.reason).toBe('allergen_safety_unavailable');
  });

  test('family_member has restrictions → allergen_safety_unavailable', async () => {
    query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: true, user_allergen_count: 0, user_dietary_count: 0, family_restriction_count: 4 }],
    });
    const res = await getJson(buildApp(), URL_OK);
    expect(res.body.reason).toBe('allergen_safety_unavailable');
  });

  test('all-zero restrictions → allergen gate passes', async () => {
    query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: true, user_allergen_count: 0, user_dietary_count: 0, family_restriction_count: 0 }],
    });
    recommendationService.getRecommendations.mockResolvedValueOnce({
      list_id: 'L1', list_version: 5, mode: 'A', candidates: [], preferred: null, alternative: null,
      banner: { trigger: false }, cache_hit: false,
    });
    const res = await getJson(buildApp(), URL_OK);
    expect(res.body.enabled).toBe(true);
    expect(res.body.blocked).toBe(false);
    expect(res.body.mode).toBe('A');
    expect(recommendationService.getRecommendations).toHaveBeenCalledTimes(1);
  });
});

describe('GATE 3 — engine', () => {
  beforeEach(() => {
    query.mockResolvedValue({
      rows: [{ recommend_stores_enabled: true, user_allergen_count: 0, user_dietary_count: 0, family_restriction_count: 0 }],
    });
  });

  test('forwards list_id, lat, lng to the service', async () => {
    recommendationService.getRecommendations.mockResolvedValueOnce({
      list_id: 'L1', list_version: 5, mode: 'A', candidates: [], preferred: null, alternative: null,
      banner: { trigger: false }, cache_hit: false,
    });
    await getJson(buildApp(), '/api/recommendations/where-to-shop?list_id=L1&lat=40.7&lng=-74.0');
    const args = recommendationService.getRecommendations.mock.calls[0][0];
    expect(args).toMatchObject({ userId: 'user-1', listId: 'L1', userLat: 40.7, userLng: -74.0 });
  });

  test('clamps radius_km to (0, 25]', async () => {
    recommendationService.getRecommendations.mockResolvedValue({
      list_id: 'L1', list_version: 1, mode: 'A', candidates: [], preferred: null, alternative: null,
      banner: { trigger: false }, cache_hit: false,
    });
    await getJson(buildApp(), '/api/recommendations/where-to-shop?list_id=L1&lat=40&lng=-74&radius_km=99');
    expect(recommendationService.getRecommendations.mock.calls[0][0].radiusKm).toBe(25);

    recommendationService.getRecommendations.mockClear();
    await getJson(buildApp(), '/api/recommendations/where-to-shop?list_id=L1&lat=40&lng=-74&radius_km=-1');
    expect(recommendationService.getRecommendations.mock.calls[0][0].radiusKm).toBeUndefined();
  });

  test('clamps candidate_limit to [1,10]', async () => {
    recommendationService.getRecommendations.mockResolvedValue({
      list_id: 'L1', list_version: 1, mode: 'A', candidates: [], preferred: null, alternative: null,
      banner: { trigger: false }, cache_hit: false,
    });
    await getJson(buildApp(), '/api/recommendations/where-to-shop?list_id=L1&lat=40&lng=-74&candidate_limit=99');
    expect(recommendationService.getRecommendations.mock.calls[0][0].candidateLimit).toBe(10);
  });

  test('engine throws "list not found" → 404', async () => {
    recommendationService.getRecommendations.mockRejectedValueOnce(new Error('list not found'));
    const res = await getJson(buildApp(), URL_OK);
    expect(res.status).toBe(404);
  });

  test('unexpected engine error → 500', async () => {
    recommendationService.getRecommendations.mockRejectedValueOnce(new Error('db down'));
    const res = await getJson(buildApp(), URL_OK);
    expect(res.status).toBe(500);
  });
});

describe('Gate ordering and zero-work guarantees', () => {
  test('opted-out user does NOT trigger the engine', async () => {
    query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: null, user_allergen_count: 0, user_dietary_count: 0, family_restriction_count: 0 }],
    });
    await getJson(buildApp(), URL_OK);
    expect(recommendationService.getRecommendations).not.toHaveBeenCalled();
    // Exactly one DB query: the gate-state lookup. No engine queries.
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('allergen-blocked user does NOT trigger the engine', async () => {
    query.mockResolvedValueOnce({
      rows: [{ recommend_stores_enabled: true, user_allergen_count: 1, user_dietary_count: 0, family_restriction_count: 0 }],
    });
    await getJson(buildApp(), URL_OK);
    expect(recommendationService.getRecommendations).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
