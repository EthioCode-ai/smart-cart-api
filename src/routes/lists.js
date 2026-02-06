// src/routes/lists.js
// ============================================================
// Shopping Lists Routes
// ============================================================

const express = require('express');
const { query, successResponse, errorResponse } = require('../models/db');
const { authenticate } = require('../middleware/auth');
const { generateShareCode } = require('../utils/helpers');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// ── GET /api/lists ──────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT sl.*, 
        (SELECT COUNT(*) FROM list_items li WHERE li.list_id = sl.id) as item_count,
        (SELECT COUNT(*) FROM list_items li WHERE li.list_id = sl.id AND li.checked = true) as checked_count,
        (SELECT COALESCE(SUM(li.price * li.quantity), 0) FROM list_items li WHERE li.list_id = sl.id) as total_cost
       FROM shopping_lists sl
       LEFT JOIN list_collaborators lc ON sl.id = lc.list_id AND lc.user_id = $1
       WHERE sl.user_id = $1 OR lc.user_id = $1
       ORDER BY sl.updated_at DESC`,
      [req.user.id]
    );

    const lists = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      shareCode: row.share_code,
      isActive: row.is_active,
      itemCount: parseInt(row.item_count),
      checkedCount: parseInt(row.checked_count),
      totalCost: parseFloat(row.total_cost) || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    successResponse(res, { lists });
  } catch (error) {
    console.error('Get lists error:', error);
    errorResponse(res, 500, 'Failed to fetch lists');
  }
});

// ── POST /api/lists ─────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return errorResponse(res, 400, 'List name is required');
    }

    const result = await query(
      `INSERT INTO shopping_lists (user_id, name)
       VALUES ($1, $2)
       RETURNING *`,
      [req.user.id, name.trim()]
    );

    const list = result.rows[0];

    successResponse(res, {
      list: {
        id: list.id,
        name: list.name,
        shareCode: list.share_code,
        isActive: list.is_active,
        itemCount: 0,
        checkedCount: 0,
        totalCost: 0,
        createdAt: list.created_at,
        updatedAt: list.updated_at,
      },
    }, 201);
  } catch (error) {
    console.error('Create list error:', error);
    errorResponse(res, 500, 'Failed to create list');
  }
});

// ── GET /api/lists/:id ──────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    // Get list
    const listResult = await query(
      `SELECT sl.* FROM shopping_lists sl
       LEFT JOIN list_collaborators lc ON sl.id = lc.list_id AND lc.user_id = $2
       WHERE sl.id = $1 AND (sl.user_id = $2 OR lc.user_id = $2)`,
      [req.params.id, req.user.id]
    );

    if (listResult.rows.length === 0) {
      return errorResponse(res, 404, 'List not found');
    }

    const list = listResult.rows[0];

    // Get items
    const itemsResult = await query(
      `SELECT li.*, u.name as added_by_name
       FROM list_items li
       LEFT JOIN users u ON li.added_by = u.id
       WHERE li.list_id = $1
       ORDER BY li.department, li.created_at`,
      [req.params.id]
    );

    const items = itemsResult.rows.map(item => ({
      id: item.id,
      name: item.name,
      price: parseFloat(item.price) || 0,
      quantity: item.quantity,
      department: item.department,
      checked: item.checked,
      addedBy: item.added_by,
      addedByName: item.added_by_name,
      createdAt: item.created_at,
    }));

    // Calculate totals
    const totalCost = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const checkedCount = items.filter(item => item.checked).length;

    successResponse(res, {
      list: {
        id: list.id,
        name: list.name,
        shareCode: list.share_code,
        isActive: list.is_active,
        itemCount: items.length,
        checkedCount,
        totalCost,
        createdAt: list.created_at,
        updatedAt: list.updated_at,
        items,
      },
    });
  } catch (error) {
    console.error('Get list error:', error);
    errorResponse(res, 500, 'Failed to fetch list');
  }
});

// ── PUT /api/lists/:id ──────────────────────────────────────

router.put('/:id', async (req, res) => {
  try {
    const { name, isActive } = req.body;

    const result = await query(
      `UPDATE shopping_lists 
       SET name = COALESCE($1, name),
           is_active = COALESCE($2, is_active),
           updated_at = NOW()
       WHERE id = $3 AND user_id = $4
       RETURNING *`,
      [name, isActive, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'List not found');
    }

    const list = result.rows[0];

    successResponse(res, {
      list: {
        id: list.id,
        name: list.name,
        shareCode: list.share_code,
        isActive: list.is_active,
        createdAt: list.created_at,
        updatedAt: list.updated_at,
      },
    });
  } catch (error) {
    console.error('Update list error:', error);
    errorResponse(res, 500, 'Failed to update list');
  }
});

// ── DELETE /api/lists/:id ───────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM shopping_lists WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'List not found');
    }

    successResponse(res, { message: 'List deleted' });
  } catch (error) {
    console.error('Delete list error:', error);
    errorResponse(res, 500, 'Failed to delete list');
  }
});

// ── POST /api/lists/:id/items ───────────────────────────────

router.post('/:id/items', async (req, res) => {
  try {
    const { name, price, quantity, department } = req.body;

    if (!name || !name.trim()) {
      return errorResponse(res, 400, 'Item name is required');
    }

    // Verify list access
    const listCheck = await query(
      `SELECT sl.id FROM shopping_lists sl
       LEFT JOIN list_collaborators lc ON sl.id = lc.list_id AND lc.user_id = $2
       WHERE sl.id = $1 AND (sl.user_id = $2 OR lc.user_id = $2)`,
      [req.params.id, req.user.id]
    );

    if (listCheck.rows.length === 0) {
      return errorResponse(res, 404, 'List not found');
    }

    const result = await query(
      `INSERT INTO list_items (list_id, name, price, quantity, department, added_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.id, name.trim(), price || 0, quantity || 1, department, req.user.id]
    );

    // Update list timestamp
    await query(
      'UPDATE shopping_lists SET updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );

    const item = result.rows[0];

    successResponse(res, {
      item: {
        id: item.id,
        name: item.name,
        price: parseFloat(item.price) || 0,
        quantity: item.quantity,
        department: item.department,
        checked: item.checked,
        addedBy: item.added_by,
        createdAt: item.created_at,
      },
    }, 201);
  } catch (error) {
    console.error('Add item error:', error);
    errorResponse(res, 500, 'Failed to add item');
  }
});

// ── PUT /api/lists/:id/items/:itemId ────────────────────────

router.put('/:id/items/:itemId', async (req, res) => {
  try {
    const { name, price, quantity, department, checked } = req.body;

    // Verify list access
    const listCheck = await query(
      `SELECT sl.id FROM shopping_lists sl
       LEFT JOIN list_collaborators lc ON sl.id = lc.list_id AND lc.user_id = $2
       WHERE sl.id = $1 AND (sl.user_id = $2 OR lc.user_id = $2)`,
      [req.params.id, req.user.id]
    );

    if (listCheck.rows.length === 0) {
      return errorResponse(res, 404, 'List not found');
    }

    const result = await query(
      `UPDATE list_items SET
        name = COALESCE($1, name),
        price = COALESCE($2, price),
        quantity = COALESCE($3, quantity),
        department = COALESCE($4, department),
        checked = COALESCE($5, checked),
        updated_at = NOW()
       WHERE id = $6 AND list_id = $7
       RETURNING *`,
      [name, price, quantity, department, checked, req.params.itemId, req.params.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Item not found');
    }

    // Update list timestamp
    await query(
      'UPDATE shopping_lists SET updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );

    const item = result.rows[0];

    successResponse(res, {
      item: {
        id: item.id,
        name: item.name,
        price: parseFloat(item.price) || 0,
        quantity: item.quantity,
        department: item.department,
        checked: item.checked,
        addedBy: item.added_by,
        createdAt: item.created_at,
      },
    });
  } catch (error) {
    console.error('Update item error:', error);
    errorResponse(res, 500, 'Failed to update item');
  }
});

// ── DELETE /api/lists/:id/items/:itemId ─────────────────────

router.delete('/:id/items/:itemId', async (req, res) => {
  try {
    // Verify list access
    const listCheck = await query(
      `SELECT sl.id FROM shopping_lists sl
       LEFT JOIN list_collaborators lc ON sl.id = lc.list_id AND lc.user_id = $2
       WHERE sl.id = $1 AND (sl.user_id = $2 OR lc.user_id = $2)`,
      [req.params.id, req.user.id]
    );

    if (listCheck.rows.length === 0) {
      return errorResponse(res, 404, 'List not found');
    }

    const result = await query(
      'DELETE FROM list_items WHERE id = $1 AND list_id = $2 RETURNING id',
      [req.params.itemId, req.params.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Item not found');
    }

    // Update list timestamp
    await query(
      'UPDATE shopping_lists SET updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );

    successResponse(res, { message: 'Item deleted' });
  } catch (error) {
    console.error('Delete item error:', error);
    errorResponse(res, 500, 'Failed to delete item');
  }
});

// ── PATCH /api/lists/:id/items/:itemId/toggle ───────────────

router.patch('/:id/items/:itemId/toggle', async (req, res) => {
  try {
    // Verify list access
    const listCheck = await query(
      `SELECT sl.id FROM shopping_lists sl
       LEFT JOIN list_collaborators lc ON sl.id = lc.list_id AND lc.user_id = $2
       WHERE sl.id = $1 AND (sl.user_id = $2 OR lc.user_id = $2)`,
      [req.params.id, req.user.id]
    );

    if (listCheck.rows.length === 0) {
      return errorResponse(res, 404, 'List not found');
    }

    const result = await query(
      `UPDATE list_items 
       SET checked = NOT checked, updated_at = NOW()
       WHERE id = $1 AND list_id = $2
       RETURNING *`,
      [req.params.itemId, req.params.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 404, 'Item not found');
    }

    const item = result.rows[0];

    successResponse(res, {
      item: {
        id: item.id,
        name: item.name,
        price: parseFloat(item.price) || 0,
        quantity: item.quantity,
        department: item.department,
        checked: item.checked,
      },
    });
  } catch (error) {
    console.error('Toggle item error:', error);
    errorResponse(res, 500, 'Failed to toggle item');
  }
});

// ── POST /api/lists/:id/share ───────────────────────────────

router.post('/:id/share', async (req, res) => {
  try {
    // Verify ownership
    const listCheck = await query(
      'SELECT id, share_code FROM shopping_lists WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (listCheck.rows.length === 0) {
      return errorResponse(res, 404, 'List not found');
    }

    let shareCode = listCheck.rows[0].share_code;

    if (!shareCode) {
      // Generate new share code
      shareCode = generateShareCode();
      await query(
        'UPDATE shopping_lists SET share_code = $1 WHERE id = $2',
        [shareCode, req.params.id]
      );
    }

    successResponse(res, { shareCode });
  } catch (error) {
    console.error('Share list error:', error);
    errorResponse(res, 500, 'Failed to share list');
  }
});

// ── POST /api/lists/join ────────────────────────────────────

router.post('/join', async (req, res) => {
  try {
    const { shareCode } = req.body;

    if (!shareCode || shareCode.length !== 6) {
      return errorResponse(res, 400, 'Valid 6-character share code required');
    }

    // Find list by share code
    const listResult = await query(
      'SELECT * FROM shopping_lists WHERE share_code = $1',
      [shareCode.toUpperCase()]
    );

    if (listResult.rows.length === 0) {
      return errorResponse(res, 404, 'Invalid share code');
    }

    const list = listResult.rows[0];

    // Check if already a collaborator or owner
    if (list.user_id === req.user.id) {
      return errorResponse(res, 400, 'You own this list');
    }

    const existingCollab = await query(
      'SELECT id FROM list_collaborators WHERE list_id = $1 AND user_id = $2',
      [list.id, req.user.id]
    );

    if (existingCollab.rows.length > 0) {
      return errorResponse(res, 400, 'You already have access to this list');
    }

    // Add as collaborator
    await query(
      'INSERT INTO list_collaborators (list_id, user_id, role) VALUES ($1, $2, $3)',
      [list.id, req.user.id, 'member']
    );

    successResponse(res, {
      message: 'Successfully joined list',
      list: {
        id: list.id,
        name: list.name,
      },
    });
  } catch (error) {
    console.error('Join list error:', error);
    errorResponse(res, 500, 'Failed to join list');
  }
});

// ── GET /api/lists/:id/cost ─────────────────────────────────

router.get('/:id/cost', async (req, res) => {
  try {
    const taxRate = 0.0875; // 8.75%

    // Get items
    const result = await query(
      `SELECT li.* FROM list_items li
       JOIN shopping_lists sl ON li.list_id = sl.id
       LEFT JOIN list_collaborators lc ON sl.id = lc.list_id AND lc.user_id = $2
       WHERE sl.id = $1 AND (sl.user_id = $2 OR lc.user_id = $2)`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      // Check if list exists but is empty
      const listCheck = await query(
        `SELECT sl.id FROM shopping_lists sl
         LEFT JOIN list_collaborators lc ON sl.id = lc.list_id AND lc.user_id = $2
         WHERE sl.id = $1 AND (sl.user_id = $2 OR lc.user_id = $2)`,
        [req.params.id, req.user.id]
      );

      if (listCheck.rows.length === 0) {
        return errorResponse(res, 404, 'List not found');
      }

      return successResponse(res, {
        subtotal: 0,
        tax: 0,
        total: 0,
        itemCount: 0,
      });
    }

    const subtotal = result.rows.reduce((sum, item) => 
      sum + (parseFloat(item.price) || 0) * (item.quantity || 1), 0
    );
    const tax = subtotal * taxRate;
    const total = subtotal + tax;

    successResponse(res, {
      subtotal: Math.round(subtotal * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      total: Math.round(total * 100) / 100,
      itemCount: result.rows.length,
    });
  } catch (error) {
    console.error('Get cost error:', error);
    errorResponse(res, 500, 'Failed to calculate cost');
  }
});

module.exports = router;
