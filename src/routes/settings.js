// src/routes/settings.js
// ============================================================
// User Settings Routes
// ============================================================

const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// ── Push Notification Helper ──
async function sendPushNotification(userId, title, body) {
  try {
    const result = await query('SELECT push_token FROM users WHERE id = $1', [userId]);
    const token = result.rows[0]?.push_token;
    if (!token) return;

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: token,
        title,
        body,
        sound: 'default',
      }),
    });
  } catch (err) {
    console.error('Push notification error:', err);
  }
}

// ── GET /api/settings ───────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    // Get or create user settings
    let settingsResult = await query(
      'SELECT * FROM user_settings WHERE user_id = $1',
      [req.user.id]
    );

    if (settingsResult.rows.length === 0) {
      // Create default settings
      await query(
        'INSERT INTO user_settings (user_id) VALUES ($1)',
        [req.user.id]
      );
      settingsResult = await query(
        'SELECT * FROM user_settings WHERE user_id = $1',
        [req.user.id]
      );
    }

    const settings = settingsResult.rows[0];

    // Get family members
    const familyResult = await query(
      'SELECT * FROM family_members WHERE user_id = $1 ORDER BY created_at',
      [req.user.id]
    );

    // Get favorite stores
    const favStoresResult = await query(
      `SELECT fs.*, s.name, s.address
       FROM favorite_stores fs
       JOIN stores s ON fs.store_id = s.id
       WHERE fs.user_id = $1
       ORDER BY fs.created_at DESC`,
      [req.user.id]
    );

    successResponse(res, {
      settings: {
        dietaryRestrictions: settings.dietary_restrictions || [],
        allergens: settings.allergens || [],
        createdAt: settings.created_at,
        updatedAt: settings.updated_at,
      },
      familyMembers: familyResult.rows.map(fm => ({
        id: fm.id,
        name: fm.name,
        relationship: fm.relationship,
        dietaryRestrictions: fm.dietary_restrictions || [],
        allergens: fm.allergens || [],
        createdAt: fm.created_at,
      })),
      favoriteStores: favStoresResult.rows.map(fs => ({
        id: fs.store_id,
        name: fs.name,
        address: fs.address,
        note: fs.description,
        addedAt: fs.created_at,
      })),
    });
  } catch (error) {
    console.error('Get settings error:', error);
    errorResponse(res, 500, 'Failed to fetch settings');
  }
});

// ── PUT /api/settings ───────────────────────────────────────

router.put('/', async (req, res) => {
  try {
    const { dietaryRestrictions, allergens } = req.body;

    const result = await query(
      `INSERT INTO user_settings (user_id, dietary_restrictions, allergens)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         dietary_restrictions = $2,
         allergens = $3,
         updated_at = NOW()
       RETURNING *`,
      [req.user.id, dietaryRestrictions, allergens]
    );

    const settings = result.rows[0];

    successResponse(res, {
      settings: {
        dietaryRestrictions: settings.dietary_restrictions || [],
        allergens: settings.allergens || [],
        updatedAt: settings.updated_at,
      },
    });
  } catch (error) {
    console.error('Update settings error:', error);
    errorResponse(res, 500, 'Failed to update settings');
  }
});

// ── GET /api/settings/dietary ───────────────────────────────

router.get('/dietary', async (req, res) => {
  try {
    const result = await query(
      'SELECT dietary_restrictions FROM user_settings WHERE user_id = $1',
      [req.user.id]
    );

    successResponse(res, {
      dietaryRestrictions: result.rows[0]?.dietary_restrictions || [],
    });
  } catch (error) {
    console.error('Get dietary error:', error);
    errorResponse(res, 500, 'Failed to fetch dietary restrictions');
  }
});

// ── PUT /api/settings/dietary ───────────────────────────────

router.put('/dietary', async (req, res) => {
  try {
    const { dietaryRestrictions } = req.body;

    if (!Array.isArray(dietaryRestrictions)) {
      return errorResponse(res, 400, 'Dietary restrictions must be an array');
    }

    await query(
      `INSERT INTO user_settings (user_id, dietary_restrictions)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         dietary_restrictions = $2,
         updated_at = NOW()`,
      [req.user.id, dietaryRestrictions]
    );

    successResponse(res, { dietaryRestrictions });
  } catch (error) {
    console.error('Update dietary error:', error);
    errorResponse(res, 500, 'Failed to update dietary restrictions');
  }
});

// ── GET /api/settings/allergens ─────────────────────────────

router.get('/allergens', async (req, res) => {
  try {
    const result = await query(
      'SELECT allergens FROM user_settings WHERE user_id = $1',
      [req.user.id]
    );

    successResponse(res, {
      allergens: result.rows[0]?.allergens || [],
    });
  } catch (error) {
    console.error('Get allergens error:', error);
    errorResponse(res, 500, 'Failed to fetch allergens');
  }
});

// ── PUT /api/settings/allergens ─────────────────────────────

router.put('/allergens', async (req, res) => {
  try {
    const { allergens } = req.body;

    if (!Array.isArray(allergens)) {
      return errorResponse(res, 400, 'Allergens must be an array');
    }

    await query(
      `INSERT INTO user_settings (user_id, allergens)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         allergens = $2,
         updated_at = NOW()`,
      [req.user.id, allergens]
    );

    successResponse(res, { allergens });
  } catch (error) {
    console.error('Update allergens error:', error);
    errorResponse(res, 500, 'Failed to update allergens');
  }
});

// ── GET /api/settings/family ────────────────────────────────

router.get('/family', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM family_members WHERE user_id = $1 ORDER BY created_at',
      [req.user.id]
    );

    const familyMembers = result.rows.map(fm => ({
      id: fm.id,
      name: fm.name,
      relationship: fm.relationship,
      dietaryRestrictions: fm.dietary_restrictions || [],
      allergens: fm.allergens || [],
      createdAt: fm.created_at,
    }));

    successResponse(res, { familyMembers });
  } catch (error) {
    console.error('Get family error:', error);
    errorResponse(res, 500, 'Failed to fetch family members');
  }
});

// ── POST /api/settings/family ───────────────────────────────

router.post('/family', async (req, res) => {
  try {
    const { name, relationship, dietaryRestrictions, allergens } = req.body;

    if (!name || !name.trim()) {
      return errorResponse(res, 400, 'Name is required');
    }

    const result = await query(
      `INSERT INTO family_members (user_id, name, relationship, dietary_restrictions, allergens)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, name.trim(), relationship, dietaryRestrictions || [], allergens || []]
    );

    const fm = result.rows[0];

    successResponse(res, {
      familyMember: {
        id: fm.id,
        name: fm.name,
        relationship: fm.relationship,
        dietaryRestrictions: fm.dietary_restrictions || [],
        allergens: fm.allergens || [],
        createdAt: fm.created_at,
      },
    }, 201);
  } catch (error) {
    console.error('Add family member error:', error);
    errorResponse(res, 500, 'Failed to add family member');
  }
});

// ── PUT /api/settings/family/:id ────────────────────────────

router.put('/family/:id', async (req, res) => {
  try {
    const { name, relationship, dietaryRestrictions, allergens } = req.body;

    const result = await query(
      `UPDATE family_members SET
        name = COALESCE($1, name),
        relationship = COALESCE($2, relationship),
        dietary_restrictions = COALESCE($3, dietary_restrictions),
        allergens = COALESCE($4, allergens)
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [name, relationship, dietaryRestrictions, allergens, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Family member not found');
    }

    const fm = result.rows[0];

    successResponse(res, {
      familyMember: {
        id: fm.id,
        name: fm.name,
        relationship: fm.relationship,
        dietaryRestrictions: fm.dietary_restrictions || [],
        allergens: fm.allergens || [],
      },
    });
  } catch (error) {
    console.error('Update family member error:', error);
    errorResponse(res, 500, 'Failed to update family member');
  }
});

// ── DELETE /api/settings/family/:id ─────────────────────────

router.delete('/family/:id', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM family_members WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Family member not found');
    }

    successResponse(res, { message: 'Family member removed' });
  } catch (error) {
    console.error('Delete family member error:', error);
    errorResponse(res, 500, 'Failed to remove family member');
  }
});

// ── GET /api/settings/history ───────────────────────────────

router.get('/history', async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const result = await query(
      `SELECT st.*, s.address
       FROM shopping_trips st
       LEFT JOIN stores s ON st.store_id = s.id
       WHERE st.user_id = $1
       ORDER BY st.trip_date DESC
       LIMIT $2`,
      [req.user.id, parseInt(limit)]
    );

    const history = result.rows.map(trip => ({
      id: trip.id,
      storeId: trip.store_id,
      storeName: trip.store_name,
      storeAddress: trip.address,
      total: parseFloat(trip.total) || 0,
      itemCount: trip.item_count,
      note: trip.note,
      date: trip.trip_date,
    }));

    successResponse(res, { history });
  } catch (error) {
    console.error('Get history error:', error);
    errorResponse(res, 500, 'Failed to fetch shopping history');
  }
});

// ── POST /api/settings/history ──────────────────────────────

router.post('/history', async (req, res) => {
  try {
    const { storeId, storeName, total, itemCount, note } = req.body;

    if (!storeName) {
      return errorResponse(res, 400, 'Store name is required');
    }

    const result = await query(
      `INSERT INTO shopping_trips (user_id, store_id, store_name, total, item_count, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.user.id, storeId, storeName, total || 0, itemCount || 0, note]
    );

    const trip = result.rows[0];

    successResponse(res, {
      trip: {
        id: trip.id,
        storeName: trip.store_name,
        total: parseFloat(trip.total),
        itemCount: trip.item_count,
        note: trip.note,
        date: trip.trip_date,
      },
    }, 201);
  } catch (error) {
    console.error('Add history error:', error);
    errorResponse(res, 500, 'Failed to add shopping trip');
  }
});

// ── GET /api/settings/family-links ──────────────────────────────
// Get all linked family members (accepted) and pending invites
router.get('/family-links', async (req, res) => {
  try {
    // Get accepted family links (bidirectional)
    const acceptedResult = await query(
      `SELECT fl.id, fl.relationship, fl.status, fl.created_at,
         CASE WHEN fl.inviter_id = $1 THEN fl.invitee_id ELSE fl.inviter_id END AS member_id,
         CASE WHEN fl.inviter_id = $1 THEN u2.name ELSE u1.name END AS member_name,
         CASE WHEN fl.inviter_id = $1 THEN u2.email ELSE u1.email END AS member_email,
         CASE WHEN fl.inviter_id = $1 THEN u2.avatar_url ELSE u1.avatar_url END AS member_avatar
       FROM family_links fl
       JOIN users u1 ON fl.inviter_id = u1.id
       JOIN users u2 ON fl.invitee_id = u2.id
       WHERE (fl.inviter_id = $1 OR fl.invitee_id = $1)
         AND fl.status = 'accepted'
       ORDER BY fl.created_at`,
      [req.user.id]
    );

    // Get pending invites I sent
    const sentResult = await query(
      `SELECT fl.id, fl.relationship, fl.status, fl.created_at,
         u.id AS member_id, u.name AS member_name, u.email AS member_email, u.avatar_url AS member_avatar
       FROM family_links fl
       JOIN users u ON fl.invitee_id = u.id
       WHERE fl.inviter_id = $1 AND fl.status = 'pending'
       ORDER BY fl.created_at DESC`,
      [req.user.id]
    );

    // Get pending invites I received
    const receivedResult = await query(
      `SELECT fl.id, fl.relationship, fl.status, fl.created_at,
         u.id AS member_id, u.name AS member_name, u.email AS member_email, u.avatar_url AS member_avatar
       FROM family_links fl
       JOIN users u ON fl.inviter_id = u.id
       WHERE fl.invitee_id = $1 AND fl.status = 'pending'
       ORDER BY fl.created_at DESC`,
      [req.user.id]
    );

    const formatLink = (row) => ({
      id: row.id,
      memberId: row.member_id,
      name: row.member_name,
      email: row.member_email,
      avatarUrl: row.member_avatar,
      relationship: row.relationship,
      status: row.status,
      createdAt: row.created_at,
    });

    successResponse(res, {
      family: acceptedResult.rows.map(formatLink),
      sentInvites: sentResult.rows.map(formatLink),
      receivedInvites: receivedResult.rows.map(formatLink),
    });
  } catch (error) {
    console.error('Get family links error:', error);
    errorResponse(res, 500, 'Failed to fetch family links');
  }
});

// ── POST /api/settings/family-links/invite ──────────────────────
router.post('/family-links/invite', async (req, res) => {
  try {
    const { email, relationship } = req.body;
    if (!email) {
      return errorResponse(res, 400, 'Email is required');
    }

    // Can't invite yourself
    if (email.toLowerCase() === req.user.email) {
      return errorResponse(res, 400, 'You cannot invite yourself');
    }

    // Find user by email
    const userResult = await query(
      'SELECT id, name, email FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (userResult.rows.length === 0) {
      return errorResponse(res, 404, 'No Smart Cart account found with that email. They need to create an account first.');
    }

    const invitee = userResult.rows[0];

    // Check if link already exists (either direction)
    const existingResult = await query(
      `SELECT id, status FROM family_links
       WHERE (inviter_id = $1 AND invitee_id = $2)
          OR (inviter_id = $2 AND invitee_id = $1)`,
      [req.user.id, invitee.id]
    );

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      if (existing.status === 'accepted') {
        return errorResponse(res, 400, 'Already linked as family');
      }
      if (existing.status === 'pending') {
        return errorResponse(res, 400, 'Invite already pending');
      }
    }

    const result = await query(
      `INSERT INTO family_links (inviter_id, invitee_id, relationship, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [req.user.id, invitee.id, relationship || null]
    );

    // Send push notification to invitee
    const inviterName = req.user.name || 'Someone';
    await sendPushNotification(
      invitee.id,
      'Family Invite',
      `${inviterName} wants to connect with you on Smart Cart`
    );

    successResponse(res, {
      invite: {
        id: result.rows[0].id,
        name: invitee.name,
        email: invitee.email,
        relationship: relationship || null,
        status: 'pending',
      },
    }, 201);
  } catch (error) {
    console.error('Send family invite error:', error);
    errorResponse(res, 500, 'Failed to send invite');
  }
});

// ── PUT /api/settings/family-links/:id/accept ───────────────────
router.put('/family-links/:id/accept', async (req, res) => {
  try {
    const result = await query(
      `UPDATE family_links SET status = 'accepted', updated_at = NOW()
       WHERE id = $1 AND invitee_id = $2 AND status = 'pending'
       RETURNING *`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Invite not found or already processed');
    }

    // Notify the inviter that their invite was accepted
    const accepterName = req.user.name || 'Someone';
    await sendPushNotification(
      result.rows[0].inviter_id,
      'Invite Accepted!',
      `${accepterName} accepted your family invite on Smart Cart`
    );

    successResponse(res, { message: 'Invite accepted!' });
  } catch (error) {
    console.error('Accept family invite error:', error);
    errorResponse(res, 500, 'Failed to accept invite');
  }
});

// ── PUT /api/settings/family-links/:id/decline ──────────────────
router.put('/family-links/:id/decline', async (req, res) => {
  try {
    const result = await query(
      `UPDATE family_links SET status = 'declined', updated_at = NOW()
       WHERE id = $1 AND invitee_id = $2 AND status = 'pending'
       RETURNING *`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Invite not found or already processed');
    }

    successResponse(res, { message: 'Invite declined' });
  } catch (error) {
    console.error('Decline family invite error:', error);
    errorResponse(res, 500, 'Failed to decline invite');
  }
});

// ── DELETE /api/settings/family-links/:id ────────────────────────
router.delete('/family-links/:id', async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM family_links
       WHERE id = $1 AND (inviter_id = $2 OR invitee_id = $2)
       RETURNING id`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Family link not found');
    }

    successResponse(res, { message: 'Family member removed' });
  } catch (error) {
    console.error('Remove family link error:', error);
    errorResponse(res, 500, 'Failed to remove family member');
  }
});

// ── POST /api/settings/family-links/share-list ──────────────────
// Share a list with a family member (auto-add as collaborator)
router.post('/family-links/share-list', async (req, res) => {
  try {
    const { listId, memberId } = req.body;
    if (!listId || !memberId) {
      return errorResponse(res, 400, 'List ID and member ID are required');
    }

    // Verify family link exists and is accepted
    const linkCheck = await query(
      `SELECT id FROM family_links
       WHERE ((inviter_id = $1 AND invitee_id = $2)
          OR (inviter_id = $2 AND invitee_id = $1))
         AND status = 'accepted'`,
      [req.user.id, memberId]
    );

    if (linkCheck.rows.length === 0) {
      return errorResponse(res, 403, 'Not a linked family member');
    }

    // Verify list ownership
    const listCheck = await query(
      'SELECT id FROM shopping_lists WHERE id = $1 AND user_id = $2',
      [listId, req.user.id]
    );

    if (listCheck.rows.length === 0) {
      return errorResponse(res, 404, 'List not found or not owned by you');
    }

    // Add as collaborator
    await query(
      `INSERT INTO list_collaborators (list_id, user_id, role)
       VALUES ($1, $2, 'editor')
       ON CONFLICT (list_id, user_id) DO NOTHING`,
      [listId, memberId]
    );

    successResponse(res, { message: 'List shared with family member' });
  } catch (error) {
    console.error('Share list with family error:', error);
    errorResponse(res, 500, 'Failed to share list');
  }
});

module.exports = router;
