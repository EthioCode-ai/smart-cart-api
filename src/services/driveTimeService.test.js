// src/services/driveTimeService.test.js
// ============================================================
// Behavior tests for driveTimeService. Mocks db.query and global
// fetch (Distance Matrix API). Verifies cache hit/miss paths,
// time-bucket logic, batch fetch behavior, and cleanup.
// ============================================================

jest.mock('../models/db', () => ({
  query: jest.fn(),
}));

const { query } = require('../models/db');
const svc = require('./driveTimeService');

beforeEach(() => {
  query.mockReset();
  delete process.env.G_MAPS;
  global.fetch = jest.fn();
});

// ── time bucket ───────────────────────────────────────────
describe('timeBucket', () => {
  test('07:30 → rush_morning', () => {
    const { timeBucket } = require('./driveTimeService');
    const d = new Date(2026, 4, 4, 7, 30, 0);
    expect(timeBucket(d)).toBe('rush_morning');
  });

  test('17:45 → rush_evening', () => {
    const { timeBucket } = require('./driveTimeService');
    const d = new Date(2026, 4, 4, 17, 45, 0);
    expect(timeBucket(d)).toBe('rush_evening');
  });

  test('12:00 → off_peak', () => {
    const { timeBucket } = require('./driveTimeService');
    const d = new Date(2026, 4, 4, 12, 0, 0);
    expect(timeBucket(d)).toBe('off_peak');
  });

  test('boundary 09:00 → off_peak (rush ends at 09)', () => {
    const { timeBucket } = require('./driveTimeService');
    const d = new Date(2026, 4, 4, 9, 0, 0);
    expect(timeBucket(d)).toBe('off_peak');
  });

  test('boundary 19:00 → off_peak (evening rush ends at 19)', () => {
    const { timeBucket } = require('./driveTimeService');
    const d = new Date(2026, 4, 4, 19, 0, 0);
    expect(timeBucket(d)).toBe('off_peak');
  });
});

// ── bucket() lat/lng rounding ─────────────────────────────
describe('bucket', () => {
  test('rounds to 3 decimals', () => {
    const { bucket } = require('./driveTimeService');
    expect(bucket(40.71234)).toBe('40.712');
    expect(bucket(-74.0073)).toBe('-74.007');
  });

  test('returns null for non-numeric input', () => {
    const { bucket } = require('./driveTimeService');
    expect(bucket(null)).toBeNull();
    expect(bucket(undefined)).toBeNull();
    expect(bucket('not a number')).toBeNull();
  });
});

// ── getDriveTime: cache hit ───────────────────────────────
describe('getDriveTime cache hit', () => {
  test('returns cached row without calling fetch', async () => {
    const { getDriveTime } = require('./driveTimeService');
    query.mockResolvedValueOnce({
      rows: [{ duration_seconds: 720, distance_meters: 5400, cached_at: new Date() }],
    });
    const result = await getDriveTime({
      userLat: 40.7123,
      userLng: -74.0067,
      storeId: 'store-1',
      storeLat: 40.75,
      storeLng: -73.99,
      now: new Date(2026, 4, 4, 12, 0, 0),
    });
    expect(result).toEqual({
      duration_seconds: 720,
      distance_meters: 5400,
      cache_hit: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();

    // SELECT issued with the right cache key
    const sql = query.mock.calls[0][0];
    const params = query.mock.calls[0][1];
    expect(sql).toMatch(/FROM drive_time_cache/);
    expect(sql).toMatch(/cached_at > NOW\(\) - INTERVAL '30 minutes'/);
    expect(params).toEqual(['40.712', '-74.007', 'store-1', 'off_peak']);
  });
});

// ── getDriveTime: cache miss (no key) ─────────────────────
describe('getDriveTime cache miss without G_MAPS', () => {
  test('returns null when no cache and no API key', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // miss
    const result = await svc.getDriveTime({
      userLat: 40.71, userLng: -74.0, storeId: 's', storeLat: 40.7, storeLng: -74.0,
    });
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── getDriveTime: cache miss → DM call → cache write ──────
describe('getDriveTime cache miss with API', () => {
  test('calls Distance Matrix and writes cache', async () => {
    process.env.G_MAPS = 'fake-key';
    query.mockResolvedValueOnce({ rows: [] });        // cache miss
    query.mockResolvedValueOnce({ rowCount: 1 });     // cache write

    global.fetch.mockResolvedValueOnce({
      json: async () => ({
        status: 'OK',
        rows: [{
          elements: [{
            status: 'OK',
            duration: { value: 600 },
            duration_in_traffic: { value: 900 },
            distance: { value: 4500 },
          }],
        }],
      }),
    });

    const result = await svc.getDriveTime({
      userLat: 40.7123,
      userLng: -74.0067,
      storeId: 'store-1',
      storeLat: 40.75,
      storeLng: -73.99,
      now: new Date(2026, 4, 4, 8, 0, 0),
    });

    // duration_in_traffic preferred over duration when present
    expect(result).toEqual({
      duration_seconds: 900,
      distance_meters: 4500,
      cache_hit: false,
    });

    // Distance Matrix URL hits the right endpoint
    const fetchUrl = global.fetch.mock.calls[0][0];
    expect(fetchUrl).toMatch(/distancematrix\/json/);
    expect(fetchUrl).toMatch(/origins=40\.7123,-74\.0067/);
    expect(fetchUrl).toMatch(/departure_time=now/);

    // Cache write uses ON CONFLICT for the composite PK
    const writeSql = query.mock.calls[1][0];
    expect(writeSql).toMatch(/INSERT INTO drive_time_cache/);
    expect(writeSql).toMatch(/ON CONFLICT \(user_lat_bucket, user_lng_bucket, store_id, time_bucket\)/);
    expect(query.mock.calls[1][1]).toEqual(['40.712', '-74.007', 'store-1', 'rush_morning', 900, 4500]);
  });
});

// ── getDriveTimes batch ────────────────────────────────────
describe('getDriveTimes batch', () => {
  test('hits cache for some, batches misses into single DM call', async () => {
    process.env.G_MAPS = 'fake-key';
    // 3 cache lookups: hit, miss, hit
    query.mockResolvedValueOnce({ rows: [{ duration_seconds: 100, distance_meters: 1000 }] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ duration_seconds: 300, distance_meters: 3000 }] });
    // 1 cache write for the miss
    query.mockResolvedValueOnce({ rowCount: 1 });

    global.fetch.mockResolvedValueOnce({
      json: async () => ({
        status: 'OK',
        rows: [{
          elements: [{
            status: 'OK',
            duration: { value: 200 },
            distance: { value: 2000 },
          }],
        }],
      }),
    });

    const stores = [
      { id: 'A', lat: 40.7, lng: -74.0 },
      { id: 'B', lat: 40.8, lng: -74.1 },
      { id: 'C', lat: 40.6, lng: -73.9 },
    ];
    const result = await svc.getDriveTimes({
      userLat: 40.7, userLng: -74.0, stores,
      now: new Date(2026, 4, 4, 12, 0, 0),
    });

    expect(result).toEqual([
      { store_id: 'A', duration_seconds: 100, distance_meters: 1000, cache_hit: true },
      { store_id: 'B', duration_seconds: 200, distance_meters: 2000, cache_hit: false },
      { store_id: 'C', duration_seconds: 300, distance_meters: 3000, cache_hit: true },
    ]);

    // Only ONE DM call for the single miss, with only B's coords
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = global.fetch.mock.calls[0][0];
    expect(url).toMatch(/origins=40\.7,-74/);
    expect(decodeURIComponent(url)).toMatch(/destinations=40\.8,-74\.1/);
  });

  test('returns all-null when stores list is empty', async () => {
    const result = await svc.getDriveTimes({ userLat: 40, userLng: -74, stores: [] });
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  test('null lat/lng → all-null without DB or fetch', async () => {
    process.env.G_MAPS = 'fake-key';
    const stores = [{ id: 'A', lat: 40.7, lng: -74.0 }];
    const result = await svc.getDriveTimes({ userLat: null, userLng: null, stores });
    expect(result).toEqual([null]);
    expect(query).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('DM error → cache hits returned, misses stay null', async () => {
    process.env.G_MAPS = 'fake-key';
    query.mockResolvedValueOnce({ rows: [{ duration_seconds: 100, distance_meters: 1000 }] });
    query.mockResolvedValueOnce({ rows: [] });
    global.fetch.mockResolvedValueOnce({
      json: async () => ({ status: 'OVER_QUERY_LIMIT' }),
    });
    const stores = [
      { id: 'A', lat: 40.7, lng: -74.0 },
      { id: 'B', lat: 40.8, lng: -74.1 },
    ];
    const result = await svc.getDriveTimes({
      userLat: 40.7, userLng: -74.0, stores,
    });
    expect(result[0].cache_hit).toBe(true);
    expect(result[1]).toBeNull();
  });
});

// ── cleanupExpiredCache ────────────────────────────────────
describe('cleanupExpiredCache', () => {
  test('emits DELETE with TTL window and returns count', async () => {
    const { cleanupExpiredCache } = require('./driveTimeService');
    query.mockResolvedValueOnce({ rowCount: 7 });
    const out = await cleanupExpiredCache();
    expect(out).toEqual({ deleted_count: 7 });
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/DELETE FROM drive_time_cache/);
    expect(sql).toMatch(/cached_at < NOW\(\) - INTERVAL '30 minutes'/);
  });

  test('returns 0 when nothing matches', async () => {
    const { cleanupExpiredCache } = require('./driveTimeService');
    query.mockResolvedValueOnce({ rowCount: 0 });
    const out = await cleanupExpiredCache();
    expect(out).toEqual({ deleted_count: 0 });
  });
});

// ── startCleanupCron ───────────────────────────────────────
describe('startCleanupCron', () => {
  test('returns an unref-able timer handle', () => {
    const { startCleanupCron, CLEANUP_INTERVAL_MS } = require('./driveTimeService');
    const handle = startCleanupCron();
    expect(handle).toBeDefined();
    expect(CLEANUP_INTERVAL_MS).toBe(5 * 60 * 1000);
    clearInterval(handle);
  });
});
