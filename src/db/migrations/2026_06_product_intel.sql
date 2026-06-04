-- ============================================================
-- 2026_06_product_intel.sql
-- ============================================================
-- VEPI (Vision-Enhanced Product Intelligence) - v1
-- Adds product_intel JSONB column to products so we can store
-- structured fingerprints extracted from product photos via
-- GPT-4o-mini vision.
--
-- Shape (documented; not enforced - it's JSONB):
--   {
--     "product_type":    "cheese",
--     "product_subtype": "parmesan",
--     "form":            "wedge",
--     "key_descriptors": ["aged", "italian"],
--     "is_a":            ["cheese", "parmesan"],
--     "is_not":          ["pizza", "frozen meal"],
--     "confidence":      0.0..1.0,
--     "vision_processed_at": "2026-06-04T...",
--     "model":           "gpt-4o-mini"
--   }
--
-- The 'is_not' field is the key innovation - it lets brand-options
-- exclude products that contain query keywords in their name but
-- aren't actually that thing (Red Baron Cheese Pizza has
-- is_not: ["cheese"], so it drops out of cheese searches).
--
-- GIN index for fast containment lookups - e.g.,
--   WHERE product_intel @> '{"product_type": "cheese"}'
--
-- Run via:  psql $DATABASE_URL -f src/db/migrations/2026_06_product_intel.sql
-- Idempotent: safe to re-run.
-- ============================================================

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS product_intel JSONB;

CREATE INDEX IF NOT EXISTS idx_products_product_intel
  ON products USING GIN (product_intel);

COMMIT;
