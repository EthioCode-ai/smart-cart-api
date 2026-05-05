// src/routes/predictions.test.js
// ============================================================
// Behavior tests for /api/predictions/list-suggestions.
// Mocks the predictionService and exercises the route handler
// via req/res stubs. The engine itself is covered separately
// in services/predictionService.test.js.
// ============================================================

jest.mock('../services/predictionService', () => ({
  getRestockSuggestions: jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

const express = require('express');
const predictionService = require('../services/predictionService');
const router = require('./predictions');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/predictions', router);
  return app;
}

// Tiny test client (no supertest) — mounts the router and dispatches via http
const http = require('http');

async function getJson(app, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get(`http://127.0.0.1:${port}${url}`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

beforeEach(() => {
  predictionService.getRestockSuggestions.mockReset();
});

describe('GET /api/predictions/list-suggestions', () => {
  test('uses banner defaults when no query params provided', async () => {
    predictionService.getRestockSuggestions.mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await getJson(app, '/api/predictions/list-suggestions');

    expect(res.status).toBe(200);
    expect(predictionService.getRestockSuggestions).toHaveBeenCalledTimes(1);
    const args = predictionService.getRestockSuggestions.mock.calls[0][0];
    expect(args).toMatchObject({
      userId: 'user-1',
      source: 'checked_list_items',
      urgencyThreshold: 0.6,
      limit: 4,
      excludeListId: null,
    });
    // minOccurrences not passed → service uses its own default (3 for checked)
    expect(args.minOccurrences).toBeUndefined();
  });

  test('passes list_id through as excludeListId', async () => {
    predictionService.getRestockSuggestions.mockResolvedValueOnce([]);
    const app = buildApp();
    await getJson(app, '/api/predictions/list-suggestions?list_id=list-42');

    const args = predictionService.getRestockSuggestions.mock.calls[0][0];
    expect(args.excludeListId).toBe('list-42');
  });

  test('clamps limit to [1, 10]', async () => {
    predictionService.getRestockSuggestions.mockResolvedValue([]);
    const app = buildApp();

    await getJson(app, '/api/predictions/list-suggestions?limit=99');
    expect(predictionService.getRestockSuggestions.mock.calls[0][0].limit).toBe(10);

    predictionService.getRestockSuggestions.mockClear();
    await getJson(app, '/api/predictions/list-suggestions?limit=0');
    expect(predictionService.getRestockSuggestions.mock.calls[0][0].limit).toBe(1);

    predictionService.getRestockSuggestions.mockClear();
    await getJson(app, '/api/predictions/list-suggestions?limit=garbage');
    expect(predictionService.getRestockSuggestions.mock.calls[0][0].limit).toBe(4);
  });

  test('forwards min_occurrences when present', async () => {
    predictionService.getRestockSuggestions.mockResolvedValueOnce([]);
    const app = buildApp();
    await getJson(app, '/api/predictions/list-suggestions?min_occurrences=5');
    expect(predictionService.getRestockSuggestions.mock.calls[0][0].minOccurrences).toBe(5);
  });

  test('returns suggestions array + count + source + list_id', async () => {
    predictionService.getRestockSuggestions.mockResolvedValueOnce([
      { name: 'Milk', price: 4.99, urgency: 1.5, _source: 'checked_list_items' },
      { name: 'Eggs', price: 3.49, urgency: 1.1, _source: 'checked_list_items' },
    ]);
    const app = buildApp();
    const res = await getJson(app, '/api/predictions/list-suggestions?list_id=L1');

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(2);
    expect(res.body.count).toBe(2);
    expect(res.body.source).toBe('checked_list_items');
    expect(res.body.list_id).toBe('L1');
  });

  test('returns 400 when source is unknown', async () => {
    predictionService.getRestockSuggestions.mockRejectedValueOnce(
      new Error('Unknown signal source: bogus')
    );
    const app = buildApp();
    const res = await getJson(app, '/api/predictions/list-suggestions?source=bogus');
    expect(res.status).toBe(400);
  });

  test('returns 500 on unexpected error', async () => {
    predictionService.getRestockSuggestions.mockRejectedValueOnce(new Error('db down'));
    const app = buildApp();
    const res = await getJson(app, '/api/predictions/list-suggestions');
    expect(res.status).toBe(500);
  });
});
