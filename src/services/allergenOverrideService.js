// src/services/allergenOverrideService.js
// ============================================================
// Track 2 commit 11: allergen-override write-path.
//
// Invoked best-effort when a list item is toggled to checked=true
// (a "purchase" signal — option (b), inline check, NOT the full
// engine and NOT frontend-trusted). For each household allergen the
// item actually carries, records a purchase against allergen_overrides
// and runs the 3x-IN transition:
//
//   strikethrough --[purchase_count reaches 3]--> normalized  (count→0)
//
// Already-normalized rows are FROZEN: no increment, no state change
// (per spec: "user does NOT already have 'normalized' ... increment").
// 3x-OUT is v1.1 (needs a non-purchase signal).
//
// DORMANT IN v1: products.allergens is sparsely populated, so
// _intersectAllergens almost always returns [] and nothing is written.
// One indexed query that returns fast-empty in the common case. The
// path lights up for real when products.allergens populates (v1.1) —
// no code change needed, just data.
//
// item_match_key MUST stay byte-identical to
// recommendationService.itemMatchKey or written overrides never
// resolve on the read side. We import it rather than re-implement.
// ============================================================

const { query } = require('../models/db');
const { itemMatchKey } = require('./recommendationService');

const NORMALIZE_THRESHOLD = 3;

// Intersection of (user_settings.allergens ∪ family_members.allergens)
// with this item's products.allergens, lowercased/trimmed. Barcode is
// the reliable key; falls back to exact lower(name) for voice/text items.
async function _intersectAllergens({ userId, barcode, name }) {
  const result = await query(
    `WITH prod AS (
       SELECT allergens
         FROM products
        WHERE ($1::text IS NOT NULL AND barcode = $1)
           OR ($1::text IS NULL AND lower(name) = $2)
        ORDER BY (barcode = $1) DESC NULLS LAST
        LIMIT 1
     ),
     prod_a AS (
       SELECT lower(trim(x)) AS a
         FROM unnest(COALESCE((SELECT allergens FROM prod), ARRAY[]::text[])) AS x
     ),
     hh AS (
       SELECT lower(trim(x)) AS a
         FROM user_settings us, unnest(COALESCE(us.allergens, ARRAY[]::text[])) AS x
        WHERE us.user_id = $3
       UNION
       SELECT lower(trim(x)) AS a
         FROM family_members fm, unnest(COALESCE(fm.allergens, ARRAY[]::text[])) AS x
        WHERE fm.user_id = $3
     )
     SELECT DISTINCT pa.a AS allergen
       FROM prod_a pa
       JOIN hh ON pa.a = hh.a`,
    [barcode || null, (name || '').trim().toLowerCase(), userId]
  );
  return result.rows.map((r) => r.allergen);
}

// Best-effort. Returns { recorded: [...], transitioned: [...] }.
// Callers MUST treat a throw as non-fatal (the user-facing toggle
// must not fail because override bookkeeping did).
async function recordPurchaseSignal({ userId, item }) {
  if (!userId || !item) return { recorded: [], transitioned: [] };

  const allergens = await _intersectAllergens({
    userId, barcode: item.barcode, name: item.name,
  });
  if (allergens.length === 0) return { recorded: [], transitioned: [] };

  const key = itemMatchKey(item);
  const recorded = [];
  const transitioned = [];

  for (const allergen of allergens) {
    // prev CTE captures the pre-upsert state so we can report a true
    // strikethrough→normalized transition (vs. an already-normalized
    // row taking another purchase, which must NOT re-report).
    const r = await query(
      `WITH prev AS (
         SELECT current_state AS old_state
           FROM allergen_overrides
          WHERE user_id = $1 AND item_match_key = $2 AND allergen = $3
       )
       INSERT INTO allergen_overrides
         (user_id, item_match_key, allergen, purchase_count,
          current_state, state_changed_at, last_purchased_at)
       VALUES ($1, $2, $3, 1, 'strikethrough', NOW(), NOW())
       ON CONFLICT (user_id, item_match_key, allergen) DO UPDATE SET
         purchase_count = CASE
           WHEN allergen_overrides.current_state = 'normalized'
             THEN allergen_overrides.purchase_count
           WHEN allergen_overrides.purchase_count + 1 >= ${NORMALIZE_THRESHOLD}
             THEN 0
           ELSE allergen_overrides.purchase_count + 1
         END,
         current_state = CASE
           WHEN allergen_overrides.current_state = 'normalized'
             THEN 'normalized'
           WHEN allergen_overrides.purchase_count + 1 >= ${NORMALIZE_THRESHOLD}
             THEN 'normalized'
           ELSE 'strikethrough'
         END,
         state_changed_at = CASE
           WHEN allergen_overrides.current_state = 'strikethrough'
                AND allergen_overrides.purchase_count + 1 >= ${NORMALIZE_THRESHOLD}
             THEN NOW()
           ELSE allergen_overrides.state_changed_at
         END,
         last_purchased_at = NOW()
       RETURNING
         current_state,
         purchase_count,
         (SELECT old_state FROM prev) AS old_state`,
      [userId, key, allergen]
    );
    const row = r.rows[0];
    recorded.push({
      allergen,
      current_state: row.current_state,
      purchase_count: parseInt(row.purchase_count, 10),
    });
    if (row.old_state === 'strikethrough' && row.current_state === 'normalized') {
      transitioned.push(allergen);
    }
  }

  return { recorded, transitioned };
}

module.exports = {
  recordPurchaseSignal,
  _intersectAllergens,
  NORMALIZE_THRESHOLD,
};
