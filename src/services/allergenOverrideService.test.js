// src/services/allergenOverrideService.test.js
// ============================================================
// Track 2 commit 12: allergen-override state-transition tests.
//
// db.query is mocked. The 3x-IN CASE logic itself executes in
// Postgres (verified by the migration smoke-check); here we lock:
//   - the dormant-in-v1 path (no intersection → zero writes)
//   - SQL shape + params (threshold, ON CONFLICT, prev-state CTE)
//   - correct interpretation of RETURNING into {recorded, transitioned}
//     across the full lifecycle (1st → 2nd → 3rd purchase →
//     already-normalized re-purchase)
//   - per-allergen independence + item_match_key (barcode vs name)
// ============================================================

jest.mock('../models/db', () => ({ query: jest.fn() }));

const { query } = require('../models/db');
const svc = require('./allergenOverrideService');

beforeEach(() => query.mockReset());

describe('guards', () => {
  test('missing userId or item → no-op, no query', async () => {
    expect(await svc.recordPurchaseSignal({})).toEqual({ recorded: [], transitioned: [] });
    expect(await svc.recordPurchaseSignal({ userId: 'u' })).toEqual({ recorded: [], transitioned: [] });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('DORMANT in v1 — no allergen intersection', () => {
  test('empty intersection → no upsert at all (the v1 common case)', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // _intersectAllergens → none
    const out = await svc.recordPurchaseSignal({
      userId: 'u1', item: { id: 'i1', name: 'Milk', barcode: '012345' },
    });
    expect(out).toEqual({ recorded: [], transitioned: [] });
    expect(query).toHaveBeenCalledTimes(1); // only the intersect query
  });

  test('intersect SQL keys on barcode, falls back to lower(name)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await svc.recordPurchaseSignal({ userId: 'u1', item: { name: '  Whole Milk ', barcode: null } });
    const params = query.mock.calls[0][1];
    expect(params[0]).toBeNull();            // barcode
    expect(params[1]).toBe('whole milk');    // lower(trim(name))
    expect(params[2]).toBe('u1');            // userId
    expect(query.mock.calls[0][0]).toMatch(/products.allergens|FROM products/);
  });
});

describe('3x-IN lifecycle', () => {
  // helper: 1st mock = intersect returns [allergen]; 2nd = the upsert RETURNING
  function mockCycle(intersect, upsertReturn) {
    query.mockResolvedValueOnce({ rows: intersect.map((a) => ({ allergen: a })) });
    query.mockResolvedValueOnce({ rows: [upsertReturn] });
  }

  test('1st purchase: fresh INSERT → strikethrough, count 1, NOT transitioned', async () => {
    mockCycle(['dairy'], { current_state: 'strikethrough', purchase_count: 1, old_state: null });
    const out = await svc.recordPurchaseSignal({
      userId: 'u1', item: { id: 'i1', name: 'Milk', barcode: 'B1' },
    });
    expect(out.recorded).toEqual([{ allergen: 'dairy', current_state: 'strikethrough', purchase_count: 1 }]);
    expect(out.transitioned).toEqual([]); // old_state null → first purchase never "transitions"
    // upsert params: userId, item_match_key (barcode wins), allergen
    expect(query.mock.calls[1][1]).toEqual(['u1', 'B1', 'dairy']);
    const sql = query.mock.calls[1][0];
    expect(sql).toMatch(/ON CONFLICT \(user_id, item_match_key, allergen\)/);
    expect(sql).toMatch(/>= 3/);              // NORMALIZE_THRESHOLD inlined
    expect(sql).toMatch(/WITH prev AS/);      // prev-state capture
  });

  test('2nd purchase: count 2, still strikethrough, NOT transitioned', async () => {
    mockCycle(['dairy'], { current_state: 'strikethrough', purchase_count: 2, old_state: 'strikethrough' });
    const out = await svc.recordPurchaseSignal({ userId: 'u1', item: { name: 'Milk' } });
    expect(out.recorded[0]).toMatchObject({ current_state: 'strikethrough', purchase_count: 2 });
    expect(out.transitioned).toEqual([]);
  });

  test('3rd purchase: flips strikethrough→normalized, count reset 0, TRANSITIONED', async () => {
    mockCycle(['dairy'], { current_state: 'normalized', purchase_count: 0, old_state: 'strikethrough' });
    const out = await svc.recordPurchaseSignal({ userId: 'u1', item: { name: 'Milk' } });
    expect(out.recorded[0]).toMatchObject({ current_state: 'normalized', purchase_count: 0 });
    expect(out.transitioned).toEqual(['dairy']); // old=strikethrough, new=normalized → reported once
  });

  test('already-normalized + another purchase: FROZEN, NOT re-transitioned', async () => {
    mockCycle(['dairy'], { current_state: 'normalized', purchase_count: 0, old_state: 'normalized' });
    const out = await svc.recordPurchaseSignal({ userId: 'u1', item: { name: 'Milk' } });
    expect(out.recorded[0]).toMatchObject({ current_state: 'normalized' });
    expect(out.transitioned).toEqual([]); // old already normalized → must NOT re-report
  });
});

describe('multiple allergens on one item', () => {
  test('each allergen upserted independently; transitions reported per-allergen', async () => {
    query.mockResolvedValueOnce({ rows: [{ allergen: 'dairy' }, { allergen: 'soy' }] });
    // dairy: flips; soy: still strikethrough
    query.mockResolvedValueOnce({ rows: [{ current_state: 'normalized', purchase_count: 0, old_state: 'strikethrough' }] });
    query.mockResolvedValueOnce({ rows: [{ current_state: 'strikethrough', purchase_count: 1, old_state: null }] });

    const out = await svc.recordPurchaseSignal({
      userId: 'u1', item: { name: 'Creamer', barcode: 'B9' },
    });
    expect(out.recorded).toHaveLength(2);
    expect(out.transitioned).toEqual(['dairy']);
    // 1 intersect + 2 upserts
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][1]).toEqual(['u1', 'B9', 'dairy']);
    expect(query.mock.calls[2][1]).toEqual(['u1', 'B9', 'soy']);
  });
});

describe('constants', () => {
  test('NORMALIZE_THRESHOLD is 3 (v1 spec)', () => {
    expect(svc.NORMALIZE_THRESHOLD).toBe(3);
  });
});
