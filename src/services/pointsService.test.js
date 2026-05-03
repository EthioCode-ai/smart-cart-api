// src/services/pointsService.test.js
// ============================================================
// Behavior-preservation tests for pointsService.
//
// Per Avi's PR 2 discipline (2026-05-03): these tests assert the EXACT
// SQL queries emitted by awardPoints / checkFirstStoreBonus / checkBadges
// match the inline implementation in storeLayouts.js prior to extraction.
// Any drift in the refactor breaks these tests.
//
// Strategy: jest.mock the db module, call the service, assert each
// query() call by SQL pattern + parameter array. Order-sensitive.
// ============================================================

jest.mock('../models/db', () => ({
  query: jest.fn(),
}));

const { query } = require('../models/db');
const {
  POINT_VALUES,
  awardPoints,
  checkFirstStoreBonus,
  checkBadges,
} = require('./pointsService');

beforeEach(() => {
  query.mockReset();
});

// ── POINT_VALUES exposed ───────────────────────────────────
describe('POINT_VALUES', () => {
  test('exports the layout-side seed values', () => {
    expect(POINT_VALUES.aisle_scan).toBe(50);
    expect(POINT_VALUES.aisle_manual).toBe(30);
    expect(POINT_VALUES.aisle_confirm).toBe(10);
    expect(POINT_VALUES.data_report).toBe(15);
    expect(POINT_VALUES.entrance_map).toBe(25);
    expect(POINT_VALUES.first_store_bonus).toBe(200);
    expect(POINT_VALUES.store_complete_bonus).toBe(500);
    expect(POINT_VALUES.streak_bonus).toBe(25);
  });

  test('exports the price-side seed values (PACS gamification)', () => {
    expect(POINT_VALUES.price_scan).toBe(10);
    expect(POINT_VALUES.price_confirm).toBe(2);
    expect(POINT_VALUES.price_stale_report).toBe(5);
  });
});

// ── awardPoints ────────────────────────────────────────────
describe('awardPoints', () => {
  test('happy path: insert transaction, upsert user_points, recompute + update level', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // INSERT point_transactions
    query.mockResolvedValueOnce({ rows: [{ total_points: 50, contributions_count: 1 }] }); // UPSERT user_points
    query.mockResolvedValueOnce({ rows: [{ level: 1, title: 'Shopper' }] }); // SELECT level_thresholds
    query.mockResolvedValueOnce({ rows: [] }); // UPDATE user_points SET level

    const result = await awardPoints(
      'user-uuid',
      50,
      'aisle_scan',
      'contrib-uuid',
      'store-uuid',
    );

    expect(query).toHaveBeenCalledTimes(4);

    // Call 1: INSERT INTO point_transactions
    expect(query.mock.calls[0][0]).toMatch(/INSERT INTO point_transactions/);
    expect(query.mock.calls[0][0]).toMatch(/user_id, points, reason, contribution_id, store_id/);
    expect(query.mock.calls[0][1]).toEqual([
      'user-uuid', 50, 'aisle_scan', 'contrib-uuid', 'store-uuid',
    ]);

    // Call 2: UPSERT user_points
    expect(query.mock.calls[1][0]).toMatch(/INSERT INTO user_points/);
    expect(query.mock.calls[1][0]).toMatch(/ON CONFLICT \(user_id\)/);
    expect(query.mock.calls[1][0]).toMatch(/total_points = user_points\.total_points \+ \$2/);
    expect(query.mock.calls[1][0]).toMatch(/contributions_count = user_points\.contributions_count \+ 1/);
    expect(query.mock.calls[1][1]).toEqual(['user-uuid', 50]);

    // Call 3: SELECT level_thresholds
    expect(query.mock.calls[2][0]).toMatch(/FROM level_thresholds/);
    expect(query.mock.calls[2][0]).toMatch(/WHERE min_points <= \$1/);
    expect(query.mock.calls[2][0]).toMatch(/ORDER BY level DESC LIMIT 1/);
    expect(query.mock.calls[2][1]).toEqual([50]);

    // Call 4: UPDATE user_points SET level
    expect(query.mock.calls[3][0]).toMatch(/UPDATE user_points SET level = \$1/);
    expect(query.mock.calls[3][0]).toMatch(/level < \$1/);
    expect(query.mock.calls[3][1]).toEqual([1, 'user-uuid']);

    expect(result).toEqual({ totalPoints: 50, points: 50 });
  });

  test('default contribution_id and store_id to null when not provided', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ total_points: 10, contributions_count: 1 }] });
    query.mockResolvedValueOnce({ rows: [] }); // no level row

    await awardPoints('u', 10, 'price_confirm');

    expect(query.mock.calls[0][1]).toEqual(['u', 10, 'price_confirm', null, null]);
    expect(query).toHaveBeenCalledTimes(3); // no UPDATE level since no rows from SELECT
  });

  test('skips UPDATE level when level_thresholds returns no rows', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ total_points: 99999, contributions_count: 1 }] });
    query.mockResolvedValueOnce({ rows: [] }); // empty thresholds

    await awardPoints('u', 99999, 'aisle_scan');

    expect(query).toHaveBeenCalledTimes(3);
  });
});

// ── checkFirstStoreBonus ──────────────────────────────────
describe('checkFirstStoreBonus', () => {
  test('returns true when no other users have contributed to this store', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const result = await checkFirstStoreBonus('user-1', 'store-A');

    expect(result).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/SELECT COUNT\(\*\) as count FROM layout_contributions/);
    expect(query.mock.calls[0][0]).toMatch(/WHERE store_id = \$1 AND user_id != \$2/);
    expect(query.mock.calls[0][1]).toEqual(['store-A', 'user-1']);
  });

  test('returns false when other users have already contributed', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: '5' }] });

    const result = await checkFirstStoreBonus('user-1', 'store-A');
    expect(result).toBe(false);
  });

  test('parses string count correctly', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // pg returns COUNT as string
    expect(await checkFirstStoreBonus('u', 's')).toBe(true);
  });
});

// ── checkBadges ────────────────────────────────────────────
describe('checkBadges', () => {
  test('awards store_expert when mapped >= 80% of store', async () => {
    query.mockResolvedValueOnce({ rows: [{ total_aisles: 10, mapped_aisles: 8 }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'b1', badge_type: 'store_expert' }] });
    query.mockResolvedValueOnce({ rows: [{ contributions_count: 5 }] }); // not 1, not >=10

    const badges = await checkBadges('user-1', 'store-A');

    expect(badges).toHaveLength(1);
    expect(badges[0].badge_type).toBe('store_expert');
    expect(query.mock.calls[0][0]).toMatch(/store_layout_stats WHERE store_id/);
    expect(query.mock.calls[1][0]).toMatch(/'store_expert'/);
  });

  test('awards first_explorer at contribution 1', async () => {
    query.mockResolvedValueOnce({ rows: [{ total_aisles: 10, mapped_aisles: 0 }] }); // <80%
    query.mockResolvedValueOnce({ rows: [{ contributions_count: 1 }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'b1', badge_type: 'first_explorer' }] });

    const badges = await checkBadges('user-1', 'store-A');

    expect(badges).toHaveLength(1);
    expect(badges[0].badge_type).toBe('first_explorer');
  });

  test('awards contributor_10 at contribution 10', async () => {
    query.mockResolvedValueOnce({ rows: [{ total_aisles: 10, mapped_aisles: 0 }] });
    query.mockResolvedValueOnce({ rows: [{ contributions_count: 10 }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'b1', badge_type: 'contributor_10' }] });

    const badges = await checkBadges('user-1', 'store-A');

    expect(badges).toHaveLength(1);
    expect(badges[0].badge_type).toBe('contributor_10');
  });

  test('awards contributor_50 at contribution >= 50 (also gets contributor_10)', async () => {
    query.mockResolvedValueOnce({ rows: [{ total_aisles: 10, mapped_aisles: 0 }] });
    query.mockResolvedValueOnce({ rows: [{ contributions_count: 50 }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'b1', badge_type: 'contributor_10' }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'b2', badge_type: 'contributor_50' }] });

    const badges = await checkBadges('user-1', 'store-A');

    expect(badges).toHaveLength(2);
    expect(badges.map(b => b.badge_type).sort()).toEqual(['contributor_10', 'contributor_50']);
  });

  test('returns empty array when no thresholds met', async () => {
    query.mockResolvedValueOnce({ rows: [{ total_aisles: 10, mapped_aisles: 1 }] }); // 10%
    query.mockResolvedValueOnce({ rows: [{ contributions_count: 5 }] });

    const badges = await checkBadges('user-1', 'store-A');
    expect(badges).toEqual([]);
  });

  test('handles missing store stats gracefully', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // no stats row
    query.mockResolvedValueOnce({ rows: [{ contributions_count: 5 }] });

    const badges = await checkBadges('user-1', 'store-A');
    expect(badges).toEqual([]); // no store_expert since stats are empty
  });

  test('handles missing user_points row gracefully', async () => {
    query.mockResolvedValueOnce({ rows: [{ total_aisles: 10, mapped_aisles: 0 }] });
    query.mockResolvedValueOnce({ rows: [] }); // no user_points row yet

    const badges = await checkBadges('user-1', 'store-A');
    expect(badges).toEqual([]); // no contribution-count badges
  });
});
