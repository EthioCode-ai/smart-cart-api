-- ============================================================
-- 2026_05_recipe_image_cache.sql
-- ============================================================
-- Recipe-image cache. Avi green-lit 2026-05-19 (Option B).
--
-- Problem this fixes:
--   /api/ai/generate-list and /api/ai/generate-image both call
--   DALL-E 3 for each new recipe. DALL-E returns a short-lived
--   OpenAI URL (~1hr expiry) and costs $0.04/standard image. Today
--   every recipe view re-generates (cost + 10-30s wait + dead links
--   on saved recipes).
--
--   This table caches the DALL-E output, persisted to Cloudinary,
--   keyed by a normalized recipe title. Second-and-after viewers of
--   the same dish get the cached Cloudinary URL instantly. First
--   viewer still waits for DALL-E, but the URL is permanent.
--
-- Key design notes:
--   - title_normalized is the de-dup key (lowercased + collapsed
--     whitespace). UNIQUE -> at most one cached image per dish title.
--   - original_title is preserved for debugging / cache-inspection.
--   - source defaults to 'dall-e-3' but is a string for future-proofing
--     (e.g. if we ever swap providers or pre-seed from stock photos).
--   - hit_count + last_used_at are telemetry: lets us see which dishes
--     are hot, and aids future cache-pruning if it ever matters.
--
-- Idempotent. BEGIN/COMMIT.
--
-- Run:
--   psql $DATABASE_URL -f src/db/migrations/2026_05_recipe_image_cache.sql
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS recipe_image_cache (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  title_normalized  TEXT         NOT NULL UNIQUE,
  original_title    TEXT         NOT NULL,
  image_url         TEXT         NOT NULL,
  source            VARCHAR(32)  NOT NULL DEFAULT 'dall-e-3',
  hit_count         INTEGER      NOT NULL DEFAULT 0,
  generated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_used_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- For inspection queries: "what dishes are hot right now?"
CREATE INDEX IF NOT EXISTS idx_recipe_image_cache_last_used
  ON recipe_image_cache (last_used_at DESC);

COMMIT;

-- ============================================================
-- SMOKE CHECKS (paste after migration completes)
-- ============================================================
-- /*
--
-- -- 1. Table + columns
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'recipe_image_cache' ORDER BY ordinal_position;
-- -- expect: id uuid NO; title_normalized text NO; original_title text NO;
-- --         image_url text NO; source varchar NO; hit_count integer NO;
-- --         generated_at timestamptz NO; last_used_at timestamptz NO
--
-- -- 2. UNIQUE on title_normalized rejects duplicates
-- INSERT INTO recipe_image_cache (title_normalized, original_title, image_url)
--   VALUES ('test dish', 'Test Dish', 'https://x/y.webp');
-- INSERT INTO recipe_image_cache (title_normalized, original_title, image_url)
--   VALUES ('test dish', 'Test Dish 2', 'https://x/z.webp');
-- -- expect: ERROR duplicate key value violates unique constraint
-- DELETE FROM recipe_image_cache WHERE title_normalized = 'test dish';
--
-- -- 3. index present
-- SELECT indexname FROM pg_indexes WHERE tablename = 'recipe_image_cache';
-- -- expect: recipe_image_cache_pkey, recipe_image_cache_title_normalized_key,
-- --         idx_recipe_image_cache_last_used
--
-- */
