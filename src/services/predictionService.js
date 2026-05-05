// src/services/predictionService.js
// ============================================================
// Restock prediction service.
//
// Extracted from /api/ai/smart-suggestions (routes/ai.js:920-) per the
// Phase 2 PR 2 discipline: move first, identical logic. The existing
// endpoint will be re-wired to call this service in the next commit
// (commit 2 of Track 2). Behavior preserved bit-exact when called with
// defaults.
//
// SIGNAL-SOURCE PATTERN (per Avi's (c) refinement, 2026-05-04):
//   The engine reads from a registry of named signal sources. Day 1
//   ships two:
//     - 'all_list_items'      — matches existing endpoint behavior
//                                (every list_item ever added by the user)
//     - 'checked_list_items'  — Avi's stronger purchase proxy:
//                                only items the user has marked checked.
//                                The new banner endpoint (commit 3) uses this.
//
//   Future sources (when wired): receipt_items, trip_items.
//   Adding a source is registering a function; no refactor needed.
//
// CATEGORY/SUBCATEGORY GAP (filed for after population data):
//   Substitution gates need category + subcategory, but list_items has
//   neither. Decision (Option A/B/C/D) lands once Avi's population
//   queries return. predictionService doesn't currently use category;
//   it's a Recommend-a-Store concern (commit 6). Captured in case
//   future predictionService extensions need it.
// ============================================================

const { query } = require('../models/db');

// ── SIGNAL SOURCES ─────────────────────────────────────────────
// Each source: async (userId, opts) => rows. Each row carries:
//   name, department, barcode, brand, times_added, last_added, first_added
// Plus _source tag for diagnostic / aggregation.
const SIGNAL_SOURCES = {
  // Day-1 default. Matches the existing /api/ai/smart-suggestions
  // SELECT bit-exact (same columns, same WHERE, same GROUP BY,
  // same HAVING). NO checked filter — captures every item ever added.
  all_list_items: async (userId, opts = {}) => {
    const minOccurrences = opts.minOccurrences ?? 2;
    const result = await query(
      `SELECT
         li.name,
         li.department,
         li.barcode,
         li.brand,
         COUNT(*) as times_added,
         MAX(li.created_at) as last_added,
         MIN(li.created_at) as first_added
       FROM list_items li
       JOIN shopping_lists sl ON li.list_id = sl.id
       WHERE sl.user_id = $1
         AND li.name IS NOT NULL
         AND li.name != ''
       GROUP BY LOWER(li.name), li.name, li.department, li.barcode, li.brand
       HAVING COUNT(*) >= $2`,
      [userId, minOccurrences]
    );
    return result.rows.map(r => ({ ...r, _source: 'all_list_items' }));
  },

  // Per Avi's (c) decision: stronger purchase proxy for the new banner.
  // Only items the user has checked off (proxy for "actually bought").
  checked_list_items: async (userId, opts = {}) => {
    const minOccurrences = opts.minOccurrences ?? 3;
    const result = await query(
      `SELECT
         li.name,
         li.department,
         li.barcode,
         li.brand,
         COUNT(*) as times_added,
         MAX(li.created_at) as last_added,
         MIN(li.created_at) as first_added
       FROM list_items li
       JOIN shopping_lists sl ON li.list_id = sl.id
       WHERE sl.user_id = $1
         AND li.name IS NOT NULL
         AND li.name != ''
         AND li.checked = true
       GROUP BY LOWER(li.name), li.name, li.department, li.barcode, li.brand
       HAVING COUNT(*) >= $2`,
      [userId, minOccurrences]
    );
    return result.rows.map(r => ({ ...r, _source: 'checked_list_items' }));
  },
};

// ── HELPERS ────────────────────────────────────────────────────

// Compute frequency / recency / urgency from a signal row.
// Mirrors the existing endpoint's math:
//   avg_days_between = (last - first) / (count - 1)  fallback 14
//   urgency          = days_since_last / avg_days_between
function computeUrgency(row) {
  const occurrences = parseInt(row.times_added);
  const lastDate = new Date(row.last_added);
  const firstDate = new Date(row.first_added);
  const daysSinceFirst = Math.max(0, (Date.now() - firstDate.getTime()) / 86400000);
  const daysSinceLast = (Date.now() - lastDate.getTime()) / 86400000;
  const span = (lastDate.getTime() - firstDate.getTime()) / 86400000;
  const avgDays = occurrences > 1 ? Math.round(span / (occurrences - 1)) : 14;
  const daysSince = Math.round(daysSinceLast);
  const urgency = avgDays > 0 ? daysSince / avgDays : 0;
  return { avgDays: avgDays || 14, daysSince, urgency };
}

// 3-tier price fetch matching existing endpoint:
//   1. store_prices min by barcode
//   2. products LIKE name (most-recent updated_at)
//   3. 0  (signals GPT fallback to caller)
async function fetchPriceForRow(row) {
  if (row.barcode) {
    const result = await query(
      `SELECT MIN(price) as best_price FROM store_prices WHERE barcode = $1 AND price > 0`,
      [row.barcode]
    );
    if (result.rows[0]?.best_price) return parseFloat(result.rows[0].best_price);
  }
  const productResult = await query(
    `SELECT price FROM products
      WHERE LOWER(name) LIKE $1 AND price > 0
      ORDER BY updated_at DESC LIMIT 1`,
    [`%${(row.name || '').toLowerCase()}%`]
  );
  if (productResult.rows[0]?.price) return parseFloat(productResult.rows[0].price);
  return 0;
}

// GPT fallback for items the DB couldn't price. Preserved from the
// existing endpoint verbatim. Returns { name -> price } map.
// Failures are caught and return {} so a single GPT outage never
// breaks the suggestions response.
async function fetchGptPriceEstimates(itemNames) {
  if (!itemNames.length) return {};
  if (!process.env.OPENAI_API_KEY) return {};
  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 400,
        messages: [
          {
            role: 'system',
            content: 'Return ONLY a JSON array of prices for these grocery items. Format: [{"name":"item","price":X.XX}]',
          },
          {
            role: 'user',
            content: `Estimate current US grocery prices: ${itemNames.join(', ')}`,
          },
        ],
      }),
    });
    const data = await openaiRes.json();
    const text = data.choices?.[0]?.message?.content || '[]';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const map = {};
    for (const entry of parsed) {
      if (entry.name && typeof entry.price === 'number') {
        map[entry.name] = entry.price;
      }
    }
    return map;
  } catch (err) {
    console.error('[predictionService] GPT price estimate failed:', err.message);
    return {};
  }
}

// Format a candidate signal into the suggestion shape the API returns.
// Matches the existing endpoint's response field-for-field.
function formatSuggestion(c, price) {
  return {
    name: c.name,
    department: c.department || 'grocery',
    barcode: c.barcode || null,
    brand: c.brand || null,
    price,
    timesAdded: parseInt(c.times_added),
    avgDaysBetween: c.avgDays,
    daysSinceLast: c.daysSince,
    urgency: Math.round(c.urgency * 100) / 100,
    reason: c.daysSince > c.avgDays
      ? `You buy this every ~${c.avgDays} days — last added ${c.daysSince} days ago`
      : `Usually every ~${c.avgDays} days — due soon`,
    _source: c._source,
  };
}

// ── MAIN ENTRY: getRestockSuggestions ─────────────────────────
//
// Returns ranked list of items the user is overdue for restocking.
// Defaults match the existing /api/ai/smart-suggestions endpoint;
// the banner endpoint (commit 3) overrides with stricter values.
//
// @param  source           which signal source to read from
// @param  minOccurrences   filter: must appear >= this many times
// @param  urgencyThreshold filter: daysSinceLast / avgDaysBetween >= this
// @param  limit            max suggestions to return
// @param  excludeListId    if set, drops items already on this list
// @param  applyDietaryFilter  reserved for later commits (no-op for now)
async function getRestockSuggestions({
  userId,
  source = 'all_list_items',
  minOccurrences = 2,
  urgencyThreshold = 0.6,
  limit = 8,
  excludeListId = null,
  applyDietaryFilter = false,
} = {}) {
  if (!userId) throw new Error('userId required');

  const sourceFn = SIGNAL_SOURCES[source];
  if (!sourceFn) throw new Error(`Unknown signal source: ${source}`);

  // Pull signals + compute urgency + filter by threshold
  const signals = await sourceFn(userId, { minOccurrences });
  if (signals.length === 0) return [];

  const candidates = signals
    .map(s => ({ ...s, ...computeUrgency(s) }))
    .filter(c => c.urgency >= urgencyThreshold);

  // Optional: exclude items already on the target list (banner mode)
  let filtered = candidates;
  if (excludeListId) {
    const onList = await query(
      `SELECT LOWER(name) AS key FROM list_items WHERE list_id = $1`,
      [excludeListId]
    );
    const onListKeys = new Set(onList.rows.map(r => r.key));
    filtered = candidates.filter(c => !onListKeys.has((c.name || '').toLowerCase()));
  }

  // applyDietaryFilter is reserved — household allergen wiring lands
  // in a follow-up commit when the family_members JOIN is in place.
  if (applyDietaryFilter) {
    // TODO(post-commit-3): JOIN family_members + filter by allergens / dietary_restrictions
  }

  // Sort: urgency desc, then occurrences desc (matches existing ORDER BY)
  filtered.sort((a, b) => {
    if (b.urgency !== a.urgency) return b.urgency - a.urgency;
    return parseInt(b.times_added) - parseInt(a.times_added);
  });

  const top = filtered.slice(0, limit);

  // Per-row price fetch (3-tier DB)
  const formatted = [];
  const needGpt = [];
  for (const c of top) {
    const price = await fetchPriceForRow(c);
    const item = formatSuggestion(c, price);
    if (price === 0) needGpt.push(item);
    formatted.push(item);
  }

  // GPT fallback for $0 items, batched
  if (needGpt.length > 0) {
    const gptPrices = await fetchGptPriceEstimates(needGpt.map(i => i.name));
    for (const item of formatted) {
      if (item.price === 0 && gptPrices[item.name] != null) {
        item.price = gptPrices[item.name];
      }
    }
  }

  return formatted;
}

module.exports = {
  getRestockSuggestions,
  SIGNAL_SOURCES,
  // exported for tests / future extension
  computeUrgency,
  fetchPriceForRow,
  fetchGptPriceEstimates,
  formatSuggestion,
};
