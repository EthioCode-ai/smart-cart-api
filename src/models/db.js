// src/models/db.js
// ============================================================
// PostgreSQL Database Connection Pool
// ============================================================

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

// ── Query Helper ────────────────────────────────────────────

const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== 'production') {
      console.log('Query executed:', { text: text.substring(0, 50), duration: `${duration}ms`, rows: result.rowCount });
    }
    return result;
  } catch (error) {
    console.error('Database query error:', error.message);
    throw error;
  }
};

// ── Transaction Helper ──────────────────────────────────────

const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ── Standard Response Helpers ───────────────────────────────

const successResponse = (res, data, statusCode = 200) => {
  res.status(statusCode).json(data);
};

const errorResponse = (res, statusCode, message, details = null) => {
  const response = { error: message };
  if (details && process.env.NODE_ENV !== 'production') {
    response.details = details;
  }
  res.status(statusCode).json(response);
};

module.exports = {
  pool,
  query,
  transaction,
  successResponse,
  errorResponse,
};
