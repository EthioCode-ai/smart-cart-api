// src/services/fraudDetector.test.js
// ============================================================
// Tests for fraudDetector.
// jest.mock the db module + assert query patterns / params + insert
// payload shapes. Verifies passive-only behavior (writes to
// fraud_signals, no rejections / no enforcement).
// ============================================================

jest.mock('../models/db', () => ({
  query: jest.fn(),
}));

const { query } = require('../models/db');
const {
  DEFAULTS,
  logSignal,
  checkRapidBurst,
  checkMultiAccountByDevice,
  checkGeofenceViolation,
  analyzeAndLog,
} = require('./fraudDetector');

beforeEach(() => {
  query.mockReset();
});

// ── DEFAULTS ───────────────────────────────────────────────
describe('DEFAULTS', () => {
  test('starting thresholds are reasonable', () => {
    expect(DEFAULTS.rapidBurstThreshold).toBe(10);
    expect(DEFAULTS.rapidBurstWindowSeconds).toBe(60);
    expect(DEFAULTS.multiAccountThreshold).toBe(3);
    expect(DEFAULTS.geofenceMaxMeters).toBe(200);
  });
});

// ── logSignal ──────────────────────────────────────────────
describe('logSignal', () => {
  test('inserts into fraud_signals with JSON details', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await logSignal('user-uuid', 'rapid_action_burst', { count: 15, threshold: 10 });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/INSERT INTO fraud_signals/);
    expect(query.mock.calls[0][0]).toMatch(/user_id, signal_type, details/);
    expect(query.mock.calls[0][1][0]).toBe('user-uuid');
    expect(query.mock.calls[0][1][1]).toBe('rapid_action_burst');
    expect(JSON.parse(query.mock.calls[0][1][2])).toEqual({ count: 15, threshold: 10 });
  });

  test('null userId is allowed (anonymous attempts)', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await logSignal(null, 'geofence_violation_attempt', {});

    expect(query.mock.calls[0][1][0]).toBeNull();
    expect(query.mock.calls[0][1][1]).toBe('geofence_violation_attempt');
  });

  test('default details is empty object when not provided', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await logSignal('user', 'point_velocity_anomaly');

    expect(JSON.parse(query.mock.calls[0][1][2])).toEqual({});
  });
});

// ── checkRapidBurst ────────────────────────────────────────
describe('checkRapidBurst', () => {
  test('returns triggered=true when count exceeds threshold', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 15 }] });

    const result = await checkRapidBurst('user-1');

    expect(result.triggered).toBe(true);
    expect(result.count).toBe(15);
    expect(result.threshold).toBe(10);
    expect(result.windowSeconds).toBe(60);
  });

  test('returns triggered=false when count is at threshold (must EXCEED)', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 10 }] });

    const result = await checkRapidBurst('user-1');
    expect(result.triggered).toBe(false);
  });

  test('returns triggered=false when count is below threshold', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 3 }] });

    const result = await checkRapidBurst('user-1');
    expect(result.triggered).toBe(false);
  });

  test('queries point_transactions in the configured window', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 0 }] });

    await checkRapidBurst('user-1', { windowSeconds: 30 });

    expect(query.mock.calls[0][0]).toMatch(/FROM point_transactions/);
    expect(query.mock.calls[0][0]).toMatch(/created_at > NOW\(\) - \(\$2 \|\| ' seconds'\)::interval/);
    expect(query.mock.calls[0][1]).toEqual(['user-1', 30]);
  });

  test('threshold override is respected', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 6 }] });

    const result = await checkRapidBurst('user-1', { threshold: 5 });
    expect(result.triggered).toBe(true);
    expect(result.threshold).toBe(5);
  });
});

// ── checkMultiAccountByDevice ──────────────────────────────
describe('checkMultiAccountByDevice', () => {
  test('triggers when count >= threshold', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 3, device_fingerprint: 'fp-abc' }] });

    const result = await checkMultiAccountByDevice('user-1');

    expect(result.triggered).toBe(true);
    expect(result.count).toBe(3);
    expect(result.threshold).toBe(3);
  });

  test('returns triggered=false when only 1 user has the fingerprint', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 1, device_fingerprint: 'fp-abc' }] });

    const result = await checkMultiAccountByDevice('user-1');
    expect(result.triggered).toBe(false);
  });

  test('returns count=0 when user has no device_fingerprint', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await checkMultiAccountByDevice('user-1');
    expect(result.triggered).toBe(false);
    expect(result.count).toBe(0);
  });
});

// ── checkGeofenceViolation ─────────────────────────────────
describe('checkGeofenceViolation', () => {
  test('triggers when user is far from store (Haversine)', () => {
    // Walmart Bentonville to Wal-Mart Springdale: ~30 km
    const result = checkGeofenceViolation(
      36.3729, -94.2088,  // Bentonville
      36.1867, -94.1288,  // Springdale (rough)
    );

    expect(result.triggered).toBe(true);
    expect(result.distanceMeters).toBeGreaterThan(15000);
  });

  test('does not trigger when user is at the store', () => {
    const result = checkGeofenceViolation(
      36.3729, -94.2088,
      36.3729, -94.2088,
    );

    expect(result.triggered).toBe(false);
    expect(result.distanceMeters).toBe(0);
  });

  test('does not trigger when within 200m default', () => {
    // ~150m offset
    const result = checkGeofenceViolation(
      36.3729, -94.2088,
      36.3742, -94.2088,
    );

    expect(result.triggered).toBe(false);
    expect(result.distanceMeters).toBeLessThan(200);
  });

  test('respects custom maxMeters', () => {
    const result = checkGeofenceViolation(
      36.3729, -94.2088,
      36.3742, -94.2088,
      { maxMeters: 50 },
    );

    expect(result.triggered).toBe(true);
    expect(result.threshold).toBe(50);
  });

  test('returns triggered=false with reason when coordinates missing', () => {
    const result = checkGeofenceViolation(null, null, 0, 0);

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('missing_coords');
    expect(result.distanceMeters).toBeNull();
  });
});

// ── analyzeAndLog ──────────────────────────────────────────
describe('analyzeAndLog', () => {
  test('logs rapid_action_burst when triggered', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 20 }] });        // checkRapidBurst
    query.mockResolvedValueOnce({ rows: [{ count: 1, device_fingerprint: null }] }); // checkMultiAccount (not triggered)
    query.mockResolvedValueOnce({ rows: [] });                     // logSignal for rapid burst

    const fired = await analyzeAndLog('user-1', { action: 'price_scan' });

    expect(fired).toEqual(['rapid_action_burst']);
    // Verify the logSignal write happened with correct details
    const insertCall = query.mock.calls.find(c => /INSERT INTO fraud_signals/.test(c[0]));
    expect(insertCall).toBeDefined();
    expect(insertCall[1][1]).toBe('rapid_action_burst');
    const details = JSON.parse(insertCall[1][2]);
    expect(details.action).toBe('price_scan');
    expect(details.count).toBe(20);
  });

  test('logs multi_account_suspicion when triggered', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 0 }] });           // burst not triggered
    query.mockResolvedValueOnce({ rows: [{ count: 5, device_fingerprint: 'fp' }] }); // multi triggered
    query.mockResolvedValueOnce({ rows: [] });                       // logSignal

    const fired = await analyzeAndLog('user-1', {});

    expect(fired).toEqual(['multi_account_suspicion']);
    const insertCall = query.mock.calls.find(c => /INSERT INTO fraud_signals/.test(c[0]));
    const details = JSON.parse(insertCall[1][2]);
    // PII directive: device_fingerprint must NOT be in logged details
    expect(details.device_fingerprint).toBeUndefined();
    expect(details.fingerprint).toBeUndefined();
  });

  test('logs geofence_violation_attempt when triggered', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    query.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    query.mockResolvedValueOnce({ rows: [] }); // logSignal

    const fired = await analyzeAndLog('user-1', {
      action: 'aisle_scan',
      userLat: 36.3729, userLng: -94.2088,
      expectedStoreLat: 36.1867, expectedStoreLng: -94.1288,
    });

    expect(fired).toEqual(['geofence_violation_attempt']);
    const insertCall = query.mock.calls.find(c => /INSERT INTO fraud_signals/.test(c[0]));
    const details = JSON.parse(insertCall[1][2]);
    expect(details.action).toBe('aisle_scan');
    expect(details.distanceMeters).toBeGreaterThan(0);
    // PII: latitude/longitude must NOT be in logged details
    expect(details.userLat).toBeUndefined();
    expect(details.userLng).toBeUndefined();
    expect(details.lat).toBeUndefined();
    expect(details.lng).toBeUndefined();
  });

  test('returns empty array when nothing triggers', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    query.mockResolvedValueOnce({ rows: [{ count: 0 }] });

    const fired = await analyzeAndLog('user-1', {});

    expect(fired).toEqual([]);
    // No INSERT INTO fraud_signals calls
    const inserts = query.mock.calls.filter(c => /INSERT INTO fraud_signals/.test(c[0]));
    expect(inserts).toHaveLength(0);
  });

  test('skips checks when userId is null', async () => {
    const fired = await analyzeAndLog(null, {});

    expect(fired).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  test('multiple signals can fire in one call', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 50 }] });        // burst
    query.mockResolvedValueOnce({ rows: [] });                     // logSignal burst
    query.mockResolvedValueOnce({ rows: [{ count: 4, device_fingerprint: 'fp' }] }); // multi
    query.mockResolvedValueOnce({ rows: [] });                     // logSignal multi

    const fired = await analyzeAndLog('user-1', { action: 'aisle_scan' });

    expect(fired.sort()).toEqual(['multi_account_suspicion', 'rapid_action_burst']);
  });
});
