// src/routes/stores.products.test.js
// ============================================================
// Tests for GET /api/stores/:id/products - the moat-consumption
// endpoint that surfaces in-store-scanned products for a store
// so the Browse-by-Store UI can read them into a shopping list.
//
// Avi-locked spec (2026-06-02):
//   - All scans at the store (no scanned_by filter)
//   - Voice/text excluded by construction (not in store_prices)
//   - Most-recent price per (store_id, barcode) UNIQUE row
//   - Pagination: limit default 50 / cap 200, offset 0+
//   - Search: optional ILIKE on product name
// ============================================================

jest.mock('../models/db', () => ({
  query: jest.fn(),
  successResponse: (res, data, status = 200) => res.status(status).json(data),
  errorResponse: (res, status, message) => res.status(status).json({ error: message }),
}));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'user-1' }; next(); },
  optionalAuth: (req, _res, next) => { next(); },
}));

const express = require('express');
const http = require('http');
const { query } = require('../models/db');
const router = require('./stores');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/stores', router);
  return a;
}
function call(appInst, method, path) {
  return new Promise((resolve, reject) => {
    const server = appInst.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        { host: '127.0.0.1', port, path, method },
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

beforeEach(() => query.mockReset());

describe('GET /api/stores/:id/products', () => {
  const STORE_ID = 'store-uuid-1';

  test('404 when store does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // store lookup miss
    const { status, body } = await call(app(), 'GET', `/api/stores/${STORE_ID}/products`);
    expect(status).toBe(404);
    expect(body.error).toBe('Store not found');
  });

  test('returns paginated products with default limit=50 offset=0', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: STORE_ID, name: 'Walmart Supercenter' }] })
      .mockResolvedValueOnce({
        rows: [
          { barcode: '012345', name: 'Whole Milk', brand: 'Great Value', category: 'Dairy',
            image_url: 'https://cdn/milk.jpg', price: '3.99', regular_price: '4.49',
            unit_price: '0.50', aisle_number: '12', source: 'barcode',
            last_scanned_at: '2026-05-30T10:23:00Z', total_count: '2' },
          { barcode: '067890', name: 'Bread', brand: null, category: 'Bakery',
            image_url: null, price: '2.49', regular_price: null,
            unit_price: null, aisle_number: '8', source: 'gpt_vision',
            last_scanned_at: '2026-05-28T14:11:00Z', total_count: '2' },
        ],
      });

    const { status, body } = await call(app(), 'GET', `/api/stores/${STORE_ID}/products`);
    expect(status).toBe(200);
    expect(body.store).toEqual({ id: STORE_ID, name: 'Walmart Supercenter' });
    expect(body.products).toHaveLength(2);
    expect(body.products[0]).toEqual({
      barcode: '012345', name: 'Whole Milk', brand: 'Great Value', category: 'Dairy',
      imageUrl: 'https://cdn/milk.jpg', price: 3.99, regularPrice: 4.49,
      unitPrice: 0.50, aisleNumber: '12', source: 'barcode',
      lastScannedAt: '2026-05-30T10:23:00Z',
    });
    expect(body.products[1].imageUrl).toBeNull();
    expect(body.products[1].regularPrice).toBeNull();
    expect(body.total).toBe(2);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  test('returns empty list with total=0 when no products scanned at store', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: STORE_ID, name: 'Empty Mart' }] })
      .mockResolvedValueOnce({ rows: [] });
    const { status, body } = await call(app(), 'GET', `/api/stores/${STORE_ID}/products`);
    expect(status).toBe(200);
    expect(body.products).toEqual([]);
    expect(body.total).toBe(0);
  });

  test('honors limit and offset query params', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: STORE_ID, name: 'Walmart' }] })
      .mockResolvedValueOnce({ rows: [] });
    await call(app(), 'GET', `/api/stores/${STORE_ID}/products?limit=10&offset=20`);
    const productsCall = query.mock.calls[1];
    expect(productsCall[1][2]).toBe(10); // limit
    expect(productsCall[1][3]).toBe(20); // offset
  });

  test('caps limit at 200 to prevent runaway queries', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: STORE_ID, name: 'Walmart' }] })
      .mockResolvedValueOnce({ rows: [] });
    await call(app(), 'GET', `/api/stores/${STORE_ID}/products?limit=9999`);
    expect(query.mock.calls[1][1][2]).toBe(200);
  });

  test('clamps negative offset to 0', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: STORE_ID, name: 'Walmart' }] })
      .mockResolvedValueOnce({ rows: [] });
    await call(app(), 'GET', `/api/stores/${STORE_ID}/products?offset=-5`);
    expect(query.mock.calls[1][1][3]).toBe(0);
  });

  test('passes search query through as ILIKE parameter', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: STORE_ID, name: 'Walmart' }] })
      .mockResolvedValueOnce({ rows: [] });
    await call(app(), 'GET', `/api/stores/${STORE_ID}/products?q=milk`);
    expect(query.mock.calls[1][1][1]).toBe('milk');
  });

  test('treats empty search string as null (no filter)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: STORE_ID, name: 'Walmart' }] })
      .mockResolvedValueOnce({ rows: [] });
    await call(app(), 'GET', `/api/stores/${STORE_ID}/products?q=`);
    expect(query.mock.calls[1][1][1]).toBeNull();
  });

  test('graceful-degrades to empty list when store_prices table missing (42P01)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: STORE_ID, name: 'Walmart' }] })
      .mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const { status, body } = await call(app(), 'GET', `/api/stores/${STORE_ID}/products`);
    expect(status).toBe(200);
    expect(body.products).toEqual([]);
    expect(body.total).toBe(0);
  });

  test('500s on unexpected DB error', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: STORE_ID, name: 'Walmart' }] })
      .mockRejectedValueOnce(new Error('connection lost'));
    const { status, body } = await call(app(), 'GET', `/api/stores/${STORE_ID}/products`);
    expect(status).toBe(500);
    expect(body.error).toBe('Failed to fetch store products');
  });
});
