// src/middleware/auth.js
// ============================================================
// JWT Authentication Middleware
// ============================================================

const jwt = require('jsonwebtoken');
const { query, errorResponse } = require('../models/db');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// ── Verify JWT Token ────────────────────────────────────────

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse(res, 401, 'No token provided');
    }

    const token = authHeader.split(' ')[1];
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Verify user still exists
      const result = await query(
        'SELECT id, name, email, avatar_url FROM users WHERE id = $1',
        [decoded.userId]
      );

      if (result.rows.length === 0) {
        return errorResponse(res, 401, 'User not found');
      }

      req.user = result.rows[0];
      next();
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return errorResponse(res, 401, 'Token expired', { code: 'TOKEN_EXPIRED' });
      }
      return errorResponse(res, 401, 'Invalid token');
    }
  } catch (error) {
    console.error('Auth middleware error:', error);
    return errorResponse(res, 500, 'Authentication error');
  }
};

// ── Optional Auth (for public routes that benefit from user context) ─

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }

    const token = authHeader.split(' ')[1];
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const result = await query(
        'SELECT id, name, email, avatar_url FROM users WHERE id = $1',
        [decoded.userId]
      );
      req.user = result.rows.length > 0 ? result.rows[0] : null;
    } catch {
      req.user = null;
    }
    
    next();
  } catch (error) {
    req.user = null;
    next();
  }
};

// ── Generate Tokens ─────────────────────────────────────────

const generateAccessToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '15m' });
};

const generateRefreshToken = (userId) => {
  return jwt.sign({ userId, type: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });
};

const verifyRefreshToken = (token) => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'refresh') {
      throw new Error('Invalid token type');
    }
    return decoded;
  } catch (error) {
    throw error;
  }
};

module.exports = {
  authenticate,
  optionalAuth,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
};
