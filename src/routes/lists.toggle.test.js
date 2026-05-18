// src/routes/lists.toggle.test.js
// ============================================================
// Track 2 commit 12: toggle → allergen-override wiring isolation.
//
// Locks the critical safety property: the user-facing toggle must
// NEVER fail because secondary override bookkeeping failed, and the
// purchase signal fires ONLY on checked=true (un-checking is not a
// purchase).
// ============================================================

jest.mock('../models/db', () => ({
  query: jest.fn(),
  successResponse: (res, data, status = 200) => res.status(status).json(data),
  errorResponse: (res, status, message) => res.status(status).json({ error: message }),
}));
jest.mock('../services/allergenOverrideService', () => ({
  recordPurchaseSignal: jest.fn(),
}));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'user-1' }; next(); },
}));

const express = require('express');
const http = require('http');
const { query } = require('../models/db');
const allergenOverrideService = require('../services/allergenOverrideService');
const listsRouter = require('./lists');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/lists', listsRouter);
  return a;
}
function patch(appInst, url) {
  return new Promise((resolve, reject) => {
    const server = appInst.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        { host: '127.0.0.1', port, path: url, method: 'PATCH' },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }); });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

// listCheck → access OK ; UPDATE RETURNING → toggled row
function mockToggle(checkedResult) {
  query.mockResolvedValueOnce({ rows: [{ id: 'L1' }] });                    // list access
  query.mockResolvedValueOnce({ rows: [{ id: 'IT1', name: 'Milk', barcode: 'B1',
    price: '3.99', quantity: 1, department: 'dairy', checked: checkedResult }] });
}

beforeEach(() => {
  query.mockReset();
  allergenOverrideService.recordPurchaseSignal.mockReset();
  allergenOverrideService.recordPurchaseSignal.mockResolvedValue({ recorded: [], transitioned: [] });
});

describe('PATCH toggle → allergen override wiring', () => {
  test('checked=true → recordPurchaseSignal called with item', async () => {
    mockToggle(true);
    const res = await patch(app(), '/api/lists/L1/items/IT1/toggle');
    expect(res.status).toBe(200);
    expect(res.body.item.checked).toBe(true);
    expect(allergenOverrideService.recordPurchaseSignal).toHaveBeenCalledTimes(1);
    expect(allergenOverrideService.recordPurchaseSignal).toHaveBeenCalledWith({
      userId: 'user-1',
      item: { id: 'IT1', name: 'Milk', barcode: 'B1' },
    });
  });

  test('checked=false (un-checking) → recordPurchaseSignal NOT called', async () => {
    mockToggle(false);
    const res = await patch(app(), '/api/lists/L1/items/IT1/toggle');
    expect(res.status).toBe(200);
    expect(res.body.item.checked).toBe(false);
    expect(allergenOverrideService.recordPurchaseSignal).not.toHaveBeenCalled();
  });

  test('override service THROWS → toggle still returns 200 (failure swallowed)', async () => {
    mockToggle(true);
    allergenOverrideService.recordPurchaseSignal.mockRejectedValueOnce(new Error('db exploded'));
    const res = await patch(app(), '/api/lists/L1/items/IT1/toggle');
    expect(res.status).toBe(200);
    expect(res.body.item.checked).toBe(true); // toggle response intact despite override failure
  });
});
