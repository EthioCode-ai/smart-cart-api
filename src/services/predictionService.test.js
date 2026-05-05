// src/services/predictionService.test.js
// ============================================================
// Behavior-preservation tests for predictionService.
//
// Lock in: SQL emitted by each signal source + math of computeUrgency
// + 3-tier price fetch + sort/limit/exclude semantics. Behavior must
// remain bit-exact when called with /api/ai/smart-suggestions defaults.
// ============================================================

jest.mock('../models/db', () => ({
  query: jest.fn(),
}));

const { query } = require('../models/db');
const {
  getRestockSuggestions,
  SIGNAL_SOURCES,
  computeUrgency,
  fetchPriceForRow,
  formatSuggestion,
} = require('./predictionService');

beforeEach(() => {
  query.mockReset();
});

// ── SIGNAL_SOURCES.all_list_items ─────────────────────────
describe('SIGNAL_SOURCES.all_list_items', () => {
  test('emits SQL matching the existing /api/ai/smart-suggestions SELECT', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await SIGNAL_SOURCES.all_list_items('user-1', { minOccurrences: 2 });

    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    const params = query.mock.calls[0][1];

    expect(sql).toMatch(/FROM list_items li/);
    expect(sql).toMatch(/JOIN shopping_lists sl ON li\.list_id = sl\.id/);
    expect(sql).toMatch(/WHERE sl\.user_id = \$1/);
    expect(sql).toMatch(/AND li\.name IS NOT NULL/);
    expect(sql).toMatch(/AND li\.name != ''/);
    expect(sql).toMatch(/GROUP BY LOWER\(li\.name\), li\.name, li\.department, li\.barcode, li\.brand/);
    expect(sql).toMatch(/HAVING COUNT\(\*\) >= \$2/);
    // No checked filter in this source
    expect(sql).not.toMatch(/li\.checked/);
    expect(params).toEqual(['user-1', 2]);
  });

  test('uses default minOccurrences=2 when not provided', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await SIGNAL_SOURCES.all_list_items('user-1');
    expect(query.mock.calls[0][1]).toEqual(['user-1', 2]);
  });

  test('tags rows with _source: "all_list_items"', async () => {
    query.mockResolvedValueOnce({
      rows: [{ name: 'Milk', times_added: 5, last_added: '2026-05-01', first_added: '2026-04-01' }],
    });
    const out = await SIGNAL_SOURCES.all_list_items('user-1');
    expect(out[0]._source).toBe('all_list_items');
  });
});

// ── SIGNAL_SOURCES.checked_list_items ─────────────────────
describe('SIGNAL_SOURCES.checked_list_items', () => {
  test('SQL adds AND li.checked = true', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await SIGNAL_SOURCES.checked_list_items('user-1', { minOccurrences: 3 });

    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/AND li\.checked = true/);
    expect(query.mock.calls[0][1]).toEqual(['user-1', 3]);
  });

  test('default minOccurrences=3 (banner spec)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await SIGNAL_SOURCES.checked_list_items('user-1');
    expect(query.mock.calls[0][1]).toEqual(['user-1', 3]);
  });

  test('tags rows with _source: "checked_list_items"', async () => {
    query.mockResolvedValueOnce({
      rows: [{ name: 'Eggs', times_added: 4, last_added: '2026-05-02', first_added: '2026-04-15' }],
    });
    const out = await SIGNAL_SOURCES.checked_list_items('user-1');
    expect(out[0]._source).toBe('checked_list_items');
  });
});

// ── computeUrgency ──────────────────────────────────────
describe('computeUrgency', () => {
  const now = Date.now();

  test('overdue: last 12 days ago, usually every 9 days → urgency ≈ 1.33', () => {
    const row = {
      times_added: 5,
      last_added: new Date(now - 12 * 86400000),
      first_added: new Date(now - 12 * 86400000 - 36 * 86400000),
    };
    const r = computeUrgency(row);
    expect(r.avgDays).toBe(9);  // 36 / (5-1) = 9
    expect(r.daysSince).toBe(12);
    expect(r.urgency).toBeCloseTo(12 / 9, 2);
  });

  test('not yet due: last 3 days ago, usually every 14 days → urgency ≈ 0.21', () => {
    const row = {
      times_added: 3,
      last_added: new Date(now - 3 * 86400000),
      first_added: new Date(now - 31 * 86400000),
    };
    const r = computeUrgency(row);
    expect(r.avgDays).toBe(14);  // 28 / 2 = 14
    expect(r.urgency).toBeLessThan(0.5);
  });

  test('only 1 occurrence: avgDays defaults to 14', () => {
    const row = {
      times_added: 1,
      last_added: new Date(now - 5 * 86400000),
      first_added: new Date(now - 5 * 86400000),
    };
    const r = computeUrgency(row);
    expect(r.avgDays).toBe(14);
  });
});

// ── fetchPriceForRow (3-tier) ─────────────────────────────
describe('fetchPriceForRow', () => {
  test('tier 1: returns store_prices.MIN when barcode hits', async () => {
    query.mockResolvedValueOnce({ rows: [{ best_price: '4.99' }] });
    const price = await fetchPriceForRow({ barcode: '012345', name: 'Milk' });
    expect(price).toBe(4.99);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/FROM store_prices WHERE barcode = \$1 AND price > 0/);
  });

  test('tier 2: falls back to products LIKE name when store_prices empty', async () => {
    query.mockResolvedValueOnce({ rows: [] });           // store_prices miss
    query.mockResolvedValueOnce({ rows: [{ price: '3.49' }] });  // products hit
    const price = await fetchPriceForRow({ barcode: '012345', name: 'Milk' });
    expect(price).toBe(3.49);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toMatch(/FROM products/);
    expect(query.mock.calls[1][1][0]).toBe('%milk%');
  });

  test('tier 3: returns 0 when both DB tiers miss', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    const price = await fetchPriceForRow({ barcode: '012345', name: 'Truffle Salt' });
    expect(price).toBe(0);
  });

  test('skips tier 1 when barcode is null', async () => {
    query.mockResolvedValueOnce({ rows: [{ price: '2.99' }] });
    const price = await fetchPriceForRow({ barcode: null, name: 'Milk' });
    expect(price).toBe(2.99);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/FROM products/);
  });
});

// ── formatSuggestion ────────────────────────────────────
describe('formatSuggestion', () => {
  test('matches existing endpoint response shape', () => {
    const candidate = {
      name: 'Milk',
      department: 'dairy',
      barcode: '012345',
      brand: 'Horizon',
      times_added: 5,
      avgDays: 9,
      daysSince: 12,
      urgency: 1.33,
      _source: 'all_list_items',
    };
    const out = formatSuggestion(candidate, 4.99);
    expect(out).toEqual({
      name: 'Milk',
      department: 'dairy',
      barcode: '012345',
      brand: 'Horizon',
      price: 4.99,
      timesAdded: 5,
      avgDaysBetween: 9,
      daysSinceLast: 12,
      urgency: 1.33,
      reason: expect.stringContaining('every ~9 days'),
      _source: 'all_list_items',
    });
  });

  test('default department to "grocery" when missing', () => {
    const c = { name: 'X', times_added: 3, avgDays: 7, daysSince: 5, urgency: 0.71 };
    const out = formatSuggestion(c, 0);
    expect(out.department).toBe('grocery');
    expect(out.reason).toMatch(/due soon/);
  });

  test('reason switches to overdue copy when daysSince > avgDays', () => {
    const c = { name: 'X', times_added: 3, avgDays: 9, daysSince: 12, urgency: 1.33 };
    const out = formatSuggestion(c, 0);
    expect(out.reason).toMatch(/last added 12 days ago/);
  });
});

// ── getRestockSuggestions integration ─────────────────────
describe('getRestockSuggestions', () => {
  test('throws when userId is missing', async () => {
    await expect(getRestockSuggestions({})).rejects.toThrow(/userId/);
  });

  test('throws on unknown signal source', async () => {
    await expect(
      getRestockSuggestions({ userId: 'u', source: 'bogus' })
    ).rejects.toThrow(/Unknown signal source/);
  });

  test('empty signals → returns []', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const out = await getRestockSuggestions({ userId: 'u' });
    expect(out).toEqual([]);
  });

  test('filters by urgencyThreshold (existing endpoint default 0.6)', async () => {
    const now = Date.now();
    query.mockResolvedValueOnce({
      rows: [
        { name: 'Overdue', department: 'd', barcode: 'b1', brand: null,
          times_added: 5,
          last_added: new Date(now - 12 * 86400000),
          first_added: new Date(now - 48 * 86400000) },         // urgency = 12/9 = 1.33
        { name: 'NotDue', department: 'd', barcode: 'b2', brand: null,
          times_added: 5,
          last_added: new Date(now - 1 * 86400000),
          first_added: new Date(now - 37 * 86400000) },         // urgency = 1/9 = 0.11
      ],
    });
    // Tier 1 hits for both items
    query.mockResolvedValueOnce({ rows: [{ best_price: '4.99' }] });

    const out = await getRestockSuggestions({ userId: 'u', urgencyThreshold: 0.6 });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Overdue');
  });

  test('respects limit', async () => {
    const now = Date.now();
    const rows = Array.from({ length: 12 }, (_, i) => ({
      name: `Item${i}`, department: 'd', barcode: `b${i}`, brand: null,
      times_added: 5,
      last_added: new Date(now - 20 * 86400000),
      first_added: new Date(now - 56 * 86400000),
    }));
    query.mockResolvedValueOnce({ rows });
    // Each surviving item runs price fetch once
    for (let i = 0; i < 12; i++) {
      query.mockResolvedValueOnce({ rows: [{ best_price: '1.00' }] });
    }

    const out = await getRestockSuggestions({ userId: 'u', limit: 3 });
    expect(out).toHaveLength(3);
  });

  test('excludeListId removes items already on that list', async () => {
    const now = Date.now();
    query.mockResolvedValueOnce({
      rows: [
        { name: 'OnList', department: 'd', barcode: 'b1', brand: null,
          times_added: 5,
          last_added: new Date(now - 20 * 86400000),
          first_added: new Date(now - 56 * 86400000) },         // urgency 2.22
        { name: 'NotOnList', department: 'd', barcode: 'b2', brand: null,
          times_added: 5,
          last_added: new Date(now - 20 * 86400000),
          first_added: new Date(now - 56 * 86400000) },
      ],
    });
    // exclude-list query returns OnList key
    query.mockResolvedValueOnce({ rows: [{ key: 'onlist' }] });
    // Then price fetch for the survivor
    query.mockResolvedValueOnce({ rows: [{ best_price: '2.00' }] });

    const out = await getRestockSuggestions({ userId: 'u', excludeListId: 'list-X' });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('NotOnList');
  });

  test('sort: urgency desc, then occurrences desc as tiebreak', async () => {
    const now = Date.now();
    query.mockResolvedValueOnce({
      rows: [
        { name: 'A', department: 'd', barcode: null, brand: null,
          times_added: 5,
          last_added: new Date(now - 10 * 86400000),
          first_added: new Date(now - 50 * 86400000) },        // span 40 / 4 = 10 → urgency 10/10 = 1.0
        { name: 'B', department: 'd', barcode: null, brand: null,
          times_added: 8,
          last_added: new Date(now - 10 * 86400000),
          first_added: new Date(now - 80 * 86400000) },        // span 70 / 7 = 10 → urgency 10/10 = 1.0 (ties A)
        { name: 'C', department: 'd', barcode: null, brand: null,
          times_added: 5,
          last_added: new Date(now - 20 * 86400000),
          first_added: new Date(now - 60 * 86400000) },        // span 40 / 4 = 10 → urgency 20/10 = 2.0
      ],
    });
    // Each gets a price fetch (two queries per item: store_prices then products fallback)
    for (let i = 0; i < 6; i++) query.mockResolvedValueOnce({ rows: [] });

    const out = await getRestockSuggestions({ userId: 'u', urgencyThreshold: 0.5 });
    // C wins on urgency (2.0). A & B tie at 1.0 → tiebreak by times_added desc → B(8) before A(5).
    expect(out.map(s => s.name)).toEqual(['C', 'B', 'A']);
  });
});
