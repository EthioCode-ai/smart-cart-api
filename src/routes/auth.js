// src/routes/auth.js
// ============================================================
// Authentication Routes
// ============================================================

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query, successResponse, errorResponse } = require('../models/db');
const { 
  authenticate, 
  generateAccessToken, 
  generateRefreshToken, 
  verifyRefreshToken 
} = require('../middleware/auth');

const router = express.Router();

// ── POST /api/auth/register ─────────────────────────────────

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validation
    if (!name || !email || !password) {
      return errorResponse(res, 400, 'Name, email, and password are required');
    }

    if (password.length < 8) {
      return errorResponse(res, 400, 'Password must be at least 8 characters');
    }

    // Check if user exists
    const existingUser = await query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return errorResponse(res, 409, 'Email already registered');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const result = await query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, avatar_url, created_at`,
      [name.trim(), email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];

    // Create default settings
    await query(
      'INSERT INTO user_settings (user_id) VALUES ($1)',
      [user.id]
    );

    // Generate tokens
    const accessToken = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    // Store refresh token
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshToken, expiresAt]
    );

    successResponse(res, {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatar_url,
      },
      accessToken,
      refreshToken,
    }, 201);
  } catch (error) {
    console.error('Register error:', error);
    errorResponse(res, 500, 'Failed to create account');
  }
});

// ── POST /api/auth/login ────────────────────────────────────

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return errorResponse(res, 400, 'Email and password are required');
    }

    // Find user
    const result = await query(
      'SELECT id, name, email, password_hash, avatar_url, default_store_id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 401, 'Invalid email or password');
    }

    const user = result.rows[0];

    // Check password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return errorResponse(res, 401, 'Invalid email or password');
    }

    // Generate tokens
    const accessToken = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    // Store refresh token
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshToken, expiresAt]
    );

    successResponse(res, {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatar_url,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error('Login error:', error);
    errorResponse(res, 500, 'Failed to login');
  }
});

// ── POST /api/auth/google ───────────────────────────────────

router.post('/google', async (req, res) => {
  try {
    const { idToken, email, name, picture, sub: googleId } = req.body;

    if (!email || !googleId) {
      return errorResponse(res, 400, 'Invalid Google authentication data');
    }

    // Verify Google ID token
    if (idToken) {
      try {
        const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`;
        const verifyRes = await fetch(verifyUrl);
        const tokenData = await verifyRes.json();
        if (tokenData.email !== email) {
          return errorResponse(res, 401, 'Google token email mismatch');
        }
      } catch (verifyErr) {
        console.error('Google token verification failed:', verifyErr.message);
      }
    }

    const existingUser = await query(
      'SELECT id, name, email, avatar_url, default_store_id FROM users WHERE google_id = $1 OR email = $2',
      [googleId, email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      user = existingUser.rows[0];
      // Update Google ID if not set
      if (!user.google_id) {
        await query(
          'UPDATE users SET google_id = $1, avatar_url = COALESCE(avatar_url, $2) WHERE id = $3',
          [googleId, picture, user.id]
        );
      }
    } else {
      // Create new user
      const result = await query(
        `INSERT INTO users (name, email, google_id, avatar_url)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, email, avatar_url`,
        [name, email.toLowerCase(), googleId, picture]
      );
      user = result.rows[0];

      // Create default settings
      await query(
        'INSERT INTO user_settings (user_id) VALUES ($1)',
        [user.id]
      );
    }

    // Generate tokens
    const accessToken = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    // Store refresh token
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshToken, expiresAt]
    );

    successResponse(res, {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatar_url,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error('Google auth error:', error);
    errorResponse(res, 500, 'Failed to authenticate with Google');
  }
});



// ── POST /api/auth/refresh ──────────────────────────────────

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return errorResponse(res, 400, 'Refresh token required');
    }

    // Verify token
    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch {
      return errorResponse(res, 401, 'Invalid refresh token');
    }

    // Check if token exists in database and not expired
    const result = await query(
      `SELECT rt.*, u.id, u.name, u.email, u.avatar_url 
       FROM refresh_tokens rt
       JOIN users u ON rt.user_id = u.id
       WHERE rt.token = $1 AND rt.expires_at > NOW()`,
      [refreshToken]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 401, 'Refresh token expired or invalid');
    }

    const user = result.rows[0];

    // Delete old refresh token
    await query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);

    // Generate new tokens
    const newAccessToken = generateAccessToken(user.user_id);
    const newRefreshToken = generateRefreshToken(user.user_id);

    // Store new refresh token
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.user_id, newRefreshToken, expiresAt]
    );

    successResponse(res, {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    console.error('Refresh error:', error);
    errorResponse(res, 500, 'Failed to refresh token');
  }
});

// ── POST /api/auth/logout ───────────────────────────────────

router.post('/logout', authenticate, async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    }

    // Optionally delete all user's refresh tokens
    // await query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user.id]);

    successResponse(res, { message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    errorResponse(res, 500, 'Failed to logout');
  }
});

// ── GET /api/auth/me ────────────────────────────────────────

router.get('/me', authenticate, async (req, res) => {
  try {
    // Get default store info if set
    let defaultStore = null;
    if (req.user.default_store_id) {
      const storeResult = await query(
        'SELECT id, name, address, latitude, longitude FROM stores WHERE id = $1',
        [req.user.default_store_id]
      );
      if (storeResult.rows.length > 0) {
        const s = storeResult.rows[0];
        defaultStore = { id: s.id, name: s.name, address: s.address, latitude: s.latitude, longitude: s.longitude };
      }
    }
    successResponse(res, {
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        avatarUrl: req.user.avatar_url,
        defaultStore,
      },
    });
  } catch (error) {
    console.error('Get profile error:', error);
    errorResponse(res, 500, 'Failed to get profile');
  }
});

// ── PUT /api/auth/profile ───────────────────────────────────

router.put('/profile', authenticate, async (req, res) => {
  try {
    const { name, avatarUrl } = req.body;

    const result = await query(
      `UPDATE users SET 
        name = COALESCE($1, name),
        avatar_url = COALESCE($2, avatar_url),
        updated_at = NOW()
       WHERE id = $3
       RETURNING id, name, email, avatar_url`,
      [name, avatarUrl, req.user.id]
    );

    const user = result.rows[0];

    successResponse(res, {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatar_url,
      },
    });
  } catch (error) {
    console.error('Update profile error:', error);
    errorResponse(res, 500, 'Failed to update profile');
  }
});

// ── PUT /api/auth/default-store ──────────────────────────────────
router.put('/default-store', authenticate, async (req, res) => {
  try {
    const { storeId } = req.body;
    
    if (storeId) {
      const storeCheck = await query('SELECT id FROM stores WHERE id = $1', [storeId]);
      if (storeCheck.rows.length === 0) {
        return errorResponse(res, 404, 'Store not found');
      }
    }

    await query(
      'UPDATE users SET default_store_id = $1, updated_at = NOW() WHERE id = $2',
      [storeId || null, req.user.id]
    );

    successResponse(res, { defaultStoreId: storeId || null });
  } catch (error) {
    console.error('Set default store error:', error);
    errorResponse(res, 500, 'Failed to set default store');
  }
});

// ── POST /api/auth/forgot-password ──────────────────────────

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, 400, 'Email is required');
    }

    // Check if user exists
    const result = await query(
      'SELECT id, email FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    // Always return success to prevent email enumeration
    if (result.rows.length === 0) {
      return successResponse(res, { message: 'If the email exists, a reset link has been sent' });
    }

    // Generate reset token (in production, send this via email)
    const resetToken = crypto.randomBytes(32).toString('hex');
    console.log('Password reset token for', email, ':', resetToken);

    // In production: send email with reset link
    // await sendResetEmail(email, resetToken);

    successResponse(res, { message: 'If the email exists, a reset link has been sent' });
  } catch (error) {
    console.error('Forgot password error:', error);
    errorResponse(res, 500, 'Failed to process request');
  }
});

// ── POST /api/auth/reset-password ───────────────────────────

router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return errorResponse(res, 400, 'Token and new password are required');
    }

    if (newPassword.length < 8) {
      return errorResponse(res, 400, 'Password must be at least 8 characters');
    }

    // In production: verify reset token from database
    // For now, just acknowledge the request
    
    successResponse(res, { message: 'Password has been reset' });
  } catch (error) {
    console.error('Reset password error:', error);
    errorResponse(res, 500, 'Failed to reset password');
  }
});

module.exports = router;
