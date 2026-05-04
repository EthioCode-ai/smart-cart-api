-- ============================================================
-- 2026_05_phase2_recommend_a_store.sql
-- ============================================================
-- Track 2 schema additions (Recommend-a-Store + predictive prompts):
--   1. shopping_lists.list_version  - cache invalidation key
--   2. drive_time_cache             - Distance Matrix response cache
--
-- Idempotent. Wrapped in BEGIN/COMMIT.
--
-- Run:  psql $DATABASE_URL -f src/db/migrations/2026_05_phase2_recommend_a_store.sql
--
-- Pre-flight check before running:
--   \d shopping_lists       -- table is 'shopping_lists' (not 'lists');
--                              'id' is UUID; verified via earlier schema dumps
--   \d stores               -- 'id' is UUID (FK target for drive_time_cache.store_id)
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────
-- 1. shopping_lists.list_version
-- ────────────────────────────────────────────────────────────────
-- Monotonic counter, app-incremented on:
--   - item add
--   - item remove
--   - change to name, quantity, brand, or barcode
-- NOT bumped on:
--   - checked_off toggle (preserves cache hits during in-trip strike-through)
--   - notes field
--   - display-order changes
--
-- Application-level increment, not trigger. Easier to audit "what bumps
-- it" than to chase trigger logic across schema evolution. The single
-- write site lives in listsStore actions (frontend) and the
-- corresponding /api/lists/:id/items routes (backend).
--
-- Used by:
--   - Recommend-a-Store Query B cache key (15-min TTL)
--   - Predictive-prompt banner dismissal scoping
ALTER TABLE shopping_lists
  ADD COLUMN IF NOT EXISTS list_version INTEGER NOT NULL DEFAULT 0;

-- ────────────────────────────────────────────────────────────────
-- 2. drive_time_cache
-- ────────────────────────────────────────────────────────────────
-- Caches Google Distance Matrix responses for 30 min per
-- (lat-bucket, lng-bucket, store, time-bucket).
--
-- lat/lng buckets: NUMERIC(7,3) and NUMERIC(8,3) = 3-decimal precision
-- = ~100m granularity. User movements <100m hit cache; movements
-- >=100m miss and refresh.
--
-- time_bucket: 'rush_morning' (07-09 local), 'rush_evening' (16-19
-- local), 'off_peak' (everything else). Different buckets get different
-- cache entries because rush-hour drive time materially differs.
--
-- Cleanup: in-process Node setInterval in server.js, fires every 5 min,
-- runs DELETE WHERE cached_at < NOW() - INTERVAL '30 minutes' and logs
-- the deleted row count at INFO level. Lost-on-restart is fine — cache
-- is not authoritative.
CREATE TABLE IF NOT EXISTS drive_time_cache (
  user_lat_bucket   NUMERIC(7,3)  NOT NULL,
  user_lng_bucket   NUMERIC(8,3)  NOT NULL,
  store_id          UUID          NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  time_bucket       VARCHAR(16)   NOT NULL,
  duration_seconds  INTEGER       NOT NULL,
  distance_meters   INTEGER       NOT NULL,
  cached_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_lat_bucket, user_lng_bucket, store_id, time_bucket)
);

-- Lock time_bucket to the three valid values. Same drift-prevention
-- pattern as aisle_side: free-form VARCHAR + multiple writers = string
-- drift over time. Schema-level enforcement.
ALTER TABLE drive_time_cache
  DROP CONSTRAINT IF EXISTS drive_time_cache_time_bucket_check;
ALTER TABLE drive_time_cache
  ADD CONSTRAINT drive_time_cache_time_bucket_check
  CHECK (time_bucket IN ('rush_morning', 'rush_evening', 'off_peak'));

-- Cleanup index — supports the 5-min cron's DELETE WHERE cached_at < ...
CREATE INDEX IF NOT EXISTS idx_drive_time_cleanup
  ON drive_time_cache (cached_at);

COMMIT;

-- ============================================================
-- SMOKE CHECKS (paste after the migration completes)
-- ============================================================
-- /*
--
-- -- 1. list_version column on shopping_lists
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'shopping_lists' AND column_name = 'list_version';
-- -- expect: 1 row, integer, NO, 0
--
-- -- 2. drive_time_cache table exists
-- \dt drive_time_cache
-- -- expect: 1 row, owner smart_cart_d7pd_user
--
-- -- 3. CHECK constraint on time_bucket
-- SELECT pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conname = 'drive_time_cache_time_bucket_check';
-- -- expect: CHECK ((time_bucket::text = ANY (ARRAY['rush_morning'::character varying,
-- --         'rush_evening'::character varying, 'off_peak'::character varying]::text[])))
--
-- -- 4. Cleanup index
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE indexname = 'idx_drive_time_cleanup';
-- -- expect: 1 row, btree on drive_time_cache (cached_at)
--
-- -- 5. Composite PK on drive_time_cache
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'drive_time_cache'::regclass
--    AND contype = 'p';
-- -- expect: drive_time_cache_pkey | PRIMARY KEY (user_lat_bucket, user_lng_bucket, store_id, time_bucket)
--
-- -- 6. FK from drive_time_cache.store_id to stores(id)
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'drive_time_cache'::regclass
--    AND contype = 'f';
-- -- expect: drive_time_cache_store_id_fkey | FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
--
-- */
