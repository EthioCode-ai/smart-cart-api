// src/routes/scanMetrics.test.js
// ============================================================
// Phase 0 scan-metrics endpoint tests. Mocks db.query + auth,
// exercises validation, the insert shape, and the summary
// aggregation + guardrail trip-wire flags.
// ============================================================

jest.mock('../models/db', () => ({
  query: jest.fn(),
  successResponse: (res, data, status = 200) => res.status(status).json(data),
  errorResponse: (res, status, message) => res.status(status).json({ error: message }),
}));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'user-1' }; next(); },
}));

const express = require('express');
const http = require('http');
const { query } = require('../models/db');
const router = require('./scanMetrics');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/scan-metrics', router);
  return a;
}
function call(appInst, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = appInst.listen(0, () => {
      const { port } = server.address();
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(
        { host: '127.0.0.1', port, path, method,
          headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }); });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (data) req.write(data);
      req.end();
    });
  });
}

beforeEach(() => query.mockReset());

const VALID = { source: 'ocr_shelf', wasCorrected: true, correctionKind: 'price', correctionPct: 23.5, durationMs: 8400, tapCount: 3, appVersion: '2.0.6' };

describe('POST /api/scan-metrics — validation', () => {
  test('bad source -> 400, no insert', async () => {
    const r = await call(app(), 'POST', '/api/scan-metrics', { ...VALID, source: 'bogus' });
    expect(r.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  test('missing wasCorrected -> 400', async () => {
    const { wasCorrected, ...noBool } = VALID;
    const r = await call(app(), 'POST', '/api/scan-metrics', noBool);
    expect(r.status).toBe(400);
  });
  test('bad correctionKind -> 400', async () => {
    const r = await call(app(), 'POST', '/api/scan-metrics', { ...VALID, correctionKind: 'weird' });
    expect(r.status).toBe(400);
  });
  test('non-integer durationMs -> 400', async () => {
    const r = await call(app(), 'POST', '/api/scan-metrics', { ...VALID, durationMs: 12.7 });
    expect(r.status).toBe(400);
  });
  test('negative tapCount -> 400', async () => {
    const r = await call(app(), 'POST', '/api/scan-metrics', { ...VALID, tapCount: -1 });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/scan-metrics — happy path', () => {
  test('valid -> 201 + id, correct SQL params', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'm1' }] });
    const r = await call(app(), 'POST', '/api/scan-metrics', VALID);
    expect(r.status).toBe(201);
    expect(r.body.id).toBe('m1');
    const params = query.mock.calls[0][1];
    expect(params).toEqual(['user-1', 'ocr_shelf', true, 'price', 23.5, 8400, 3, '2.0.6']);
    expect(query.mock.calls[0][0]).toMatch(/INSERT INTO scan_metrics/);
  });
  test('nulls allowed for correctionKind/correctionPct/appVersion', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'm2' }] });
    const r = await call(app(), 'POST', '/api/scan-metrics',
      { source: 'barcode', wasCorrected: false, durationMs: 900, tapCount: 1 });
    expect(r.status).toBe(201);
    expect(query.mock.calls[0][1]).toEqual(['user-1', 'barcode', false, null, null, 900, 1, null]);
  });
});

describe('GET /api/scan-metrics/summary', () => {
  function mockSummary(agg, bySource = []) {
    query.mockResolvedValueOnce({ rows: [agg] });        // aggregate
    query.mockResolvedValueOnce({ rows: bySource });     // by source
  }

  test('computes flags from trip-wires (all clean)', async () => {
    mockSummary({ total: 50, correction_rate: '0.08', median_duration_ms: '6000', median_taps: '2', median_correction_pct: '5' });
    const r = await call(app(), 'GET', '/api/scan-metrics/summary');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(50);
    expect(r.body.flags).toEqual({
      correctionRateExceeded: false,
      medianDurationExceeded: false,
      medianTapsExceeded: false,
    });
    expect(r.body.tripwires).toEqual({ correctionRate: 0.15, durationMs: 12000, tapCount: 4 });
  });

  test('flags fire when trip-wires exceeded', async () => {
    mockSummary({ total: 30, correction_rate: '0.22', median_duration_ms: '15000', median_taps: '5', median_correction_pct: '40' });
    const r = await call(app(), 'GET', '/api/scan-metrics/summary');
    expect(r.body.flags).toEqual({
      correctionRateExceeded: true,
      medianDurationExceeded: true,
      medianTapsExceeded: true,
    });
  });

  test('zero rows -> no false flags', async () => {
    mockSummary({ total: 0, correction_rate: '0', median_duration_ms: '0', median_taps: '0', median_correction_pct: '0' });
    const r = await call(app(), 'GET', '/api/scan-metrics/summary');
    expect(r.body.total).toBe(0);
    expect(r.body.flags.correctionRateExceeded).toBe(false);
  });

  test('window_days clamped, source filter passes through', async () => {
    mockSummary({ total: 1, correction_rate: '0', median_duration_ms: '0', median_taps: '0', median_correction_pct: '0' });
    const r = await call(app(), 'GET', '/api/scan-metrics/summary?window_days=999&source=barcode');
    expect(r.body.windowDays).toBe(365); // clamped
    expect(r.body.source).toBe('barcode');
    expect(query.mock.calls[0][1]).toEqual([365, 'barcode']);
  });
});
