-- ============================================================
-- 2026_06_list_items_image_url.sql
-- ============================================================
-- Adds image_url column to list_items so basket items can carry
-- their product image (from products.image_url at the time of
-- add). Needed by the Browse-by-Store flow (Case-3): users tap
-- a previously-scanned item in a store's product list, the
-- image URL is captured into list_items, and ListsScreen
-- renders a thumbnail next to the row.
--
-- Nullable on purpose: items added via voice, text, AI chat,
-- and barcode-scan-without-photo will have NULL image_url.
-- The frontend falls back to a category icon when null.
--
-- Run via:  psql $DATABASE_URL -f src/db/migrations/2026_06_list_items_image_url.sql
-- Idempotent: safe to re-run.
-- ============================================================

BEGIN;

ALTER TABLE list_items
  ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMIT;
