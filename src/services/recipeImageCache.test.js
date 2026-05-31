// src/services/recipeImageCache.test.js
// ============================================================
// Pure DB-helpers around recipe_image_cache. db.query is mocked.
// Locks the contract called by ai.js generateRecipeImage and the
// /generate-list recipe-mode block:
//   - normalize(): trim, lowercase, collapse whitespace
//   - lookup(): hit returns url; miss/empty returns null; PROPAGATES DB errors
//   - recordHit(): UPDATE shape; SWALLOWS DB errors (best-effort telemetry)
//   - store(): UPSERT shape; SWALLOWS DB errors; null guard on url
// ============================================================

jest.mock('../models/db', () => ({ query: jest.fn() }));

const { query } = require('../models/db');
const cache = require('./recipeImageCache');

beforeEach(() => {
  query.mockReset();
  // Silence the intentional warn-logs from best-effort error paths so the
  // test output stays clean. Restored after each test by Jest's spy reset.
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore && console.warn.mockRestore();
});

describe('normalize', () => {
  test('lowercases, trims, collapses whitespace', () => {
    expect(cache.normalize('  Spaghetti   Bolognese  ')).toBe('spaghetti bolognese');
    expect(cache.normalize('ETHIOPIAN SHIRO')).toBe('ethiopian shiro');
    expect(cache.normalize('chicken\tcurry\nwith\trice')).toBe('chicken curry with rice');
  });
  test('null/undefined/empty -> empty string', () => {
    expect(cache.normalize(null)).toBe('');
    expect(cache.normalize(undefined)).toBe('');
    expect(cache.normalize('')).toBe('');
    expect(cache.normalize('   ')).toBe('');
  });
  test('coerces non-strings to string', () => {
    expect(cache.normalize(42)).toBe('42');
  });
});

describe('lookup', () => {
  test('hit -> returns image_url', async () => {
    query.mockResolvedValueOnce({ rows: [{ image_url: 'https://res.cloudinary.com/x.webp' }] });
    const url = await cache.lookup('Spaghetti Bolognese');
    expect(url).toBe('https://res.cloudinary.com/x.webp');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/SELECT image_url FROM recipe_image_cache/);
    expect(params).toEqual(['spaghetti bolognese']);
  });

  test('miss -> null', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await cache.lookup('Anything Else')).toBeNull();
  });

  test('empty title -> null with NO query', async () => {
    expect(await cache.lookup('   ')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  test('PROPAGATES DB errors (caller decides fallback)', async () => {
    query.mockRejectedValueOnce(new Error('connection lost'));
    await expect(cache.lookup('Some Dish')).rejects.toThrow('connection lost');
  });
});

describe('recordHit', () => {
  test('issues UPDATE with hit_count + last_used_at', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    const ok = await cache.recordHit('Spaghetti Bolognese');
    expect(ok).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE recipe_image_cache/);
    expect(sql).toMatch(/hit_count = hit_count \+ 1/);
    expect(sql).toMatch(/last_used_at = NOW\(\)/);
    expect(params).toEqual(['spaghetti bolognese']);
  });

  test('SWALLOWS DB errors (telemetry must not break user flow)', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    await expect(cache.recordHit('Some Dish')).resolves.toBe(false);
  });

  test('empty title -> no query, returns false', async () => {
    await expect(cache.recordHit('')).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('store', () => {
  test('UPSERTs with ON CONFLICT updating url, source, generated_at, last_used_at', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    const ok = await cache.store('Chicken Tikka Masala', 'https://res.cloudinary.com/y.webp', 'dall-e-3+cloudinary');
    expect(ok).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO recipe_image_cache/);
    expect(sql).toMatch(/ON CONFLICT \(title_normalized\) DO UPDATE/);
    expect(sql).toMatch(/image_url\s*=\s*EXCLUDED\.image_url/);
    expect(params).toEqual([
      'chicken tikka masala',
      'Chicken Tikka Masala',
      'https://res.cloudinary.com/y.webp',
      'dall-e-3+cloudinary',
    ]);
  });

  test('defaults source to dall-e-3 when caller omits it', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await cache.store('X', 'https://res.cloudinary.com/x.webp');
    expect(query.mock.calls[0][1][3]).toBe('dall-e-3');
  });

  test('null url -> no query, returns false', async () => {
    await expect(cache.store('Real Title', null)).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  test('SWALLOWS DB errors', async () => {
    query.mockRejectedValueOnce(new Error('unique violation race'));
    await expect(cache.store('X', 'https://x.webp')).resolves.toBe(false);
  });
});
