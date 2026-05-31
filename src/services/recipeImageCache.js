// src/services/recipeImageCache.js
// ============================================================
// Recipe-image cache. Avi green-lit 2026-05-19 (Option B).
//
// Pure DB helpers around the recipe_image_cache table:
//   - normalize(title)          -> the de-dup key
//   - lookup(title)             -> cached image URL or null
//   - recordHit(title)          -> bump hit_count + last_used_at
//   - store(title, url, source) -> upsert a new cache entry
//
// All write helpers are BEST-EFFORT: they swallow DB errors so a
// cache-write failure NEVER breaks the user-facing recipe flow.
// Lookup propagates errors so callers can decide whether to fall
// back gracefully (the AI route does, by catching).
// ============================================================

const { query } = require('../models/db');

// Lower-case, trim, collapse whitespace. Two titles that differ only
// in capitalization or padding share a single cache entry.
function normalize(title) {
  return (title == null ? '' : String(title)).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Returns the cached image URL or null. Throws on DB error so the
// caller can decide whether to treat it as a cache miss.
async function lookup(title) {
  const norm = normalize(title);
  if (!norm) return null;
  const result = await query(
    'SELECT image_url FROM recipe_image_cache WHERE title_normalized = $1',
    [norm]
  );
  return result.rows[0] ? result.rows[0].image_url : null;
}

// Best-effort. Increments hit_count + refreshes last_used_at. Errors
// are swallowed because telemetry must not affect the user response.
async function recordHit(title) {
  const norm = normalize(title);
  if (!norm) return false;
  try {
    await query(
      `UPDATE recipe_image_cache
          SET hit_count = hit_count + 1,
              last_used_at = NOW()
        WHERE title_normalized = $1`,
      [norm]
    );
    return true;
  } catch (err) {
    console.warn('[recipeImageCache] recordHit failed:', err.message);
    return false;
  }
}

// Best-effort upsert. If a row with this normalized title already
// exists, we refresh its URL (handy if we ever regenerate). Errors
// are swallowed.
async function store(title, imageUrl, source) {
  const norm = normalize(title);
  if (!norm || !imageUrl) return false;
  const src = source || 'dall-e-3';
  try {
    await query(
      `INSERT INTO recipe_image_cache (title_normalized, original_title, image_url, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (title_normalized) DO UPDATE
         SET image_url    = EXCLUDED.image_url,
             source       = EXCLUDED.source,
             generated_at = NOW(),
             last_used_at = NOW()`,
      [norm, String(title).slice(0, 256), imageUrl, src]
    );
    return true;
  } catch (err) {
    console.warn('[recipeImageCache] store failed:', err.message);
    return false;
  }
}

module.exports = { normalize, lookup, recordHit, store };
