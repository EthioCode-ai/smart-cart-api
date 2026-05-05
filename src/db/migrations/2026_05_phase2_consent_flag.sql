-- ============================================================
-- 2026_05_phase2_consent_flag.sql
-- ============================================================
-- Track 2 commit 6.5: Recommend-a-Store consent flag.
--
-- Adds user_settings.recommend_stores_enabled (NULLABLE BOOLEAN):
--
--   NULL   = user has not yet answered (treat as OFF in code paths)
--   true   = user has explicitly opted in
--   false  = user has explicitly opted out
--
-- Why three states (and why NULL is not the same as false):
--   The design distinguishes "never answered" from "actively
--   opted out" because they're meaningfully different for
--   future product decisions:
--     - NULL users may receive a one-time educational nudge
--       in Settings to discover the feature.
--     - false users have made a decision and should not be
--       prompted again.
--   Conflating the two now would lose information that is
--   load-bearing for future iterations.
--
-- Why on user_settings (not on users):
--   user_settings already owns user-level preference data
--   (dietary_restrictions, allergens). Recommend-a-Store
--   consent is in the same weight class. users stays an
--   identity / auth table.
--
-- Default state in product:
--   Toggle in Settings shows OFF for both NULL and false. The
--   endpoint /api/recommendations/where-to-shop returns
--   { enabled: false, reason: "user_not_opted_in" } and
--   performs ZERO downstream work in either case.
--
-- Idempotent. Wrapped in BEGIN/COMMIT.
--
-- Run:
--   psql $DATABASE_URL -f src/db/migrations/2026_05_phase2_consent_flag.sql
--
-- Pre-flight check before running:
--   \d user_settings    -- table exists; user_id column present;
--                          should not already have recommend_stores_enabled
-- ============================================================

BEGIN;

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS recommend_stores_enabled BOOLEAN;

COMMIT;

-- ============================================================
-- SMOKE CHECKS (paste after the migration completes)
-- ============================================================
-- /*
--
-- -- 1. Column exists, is BOOLEAN, is NULLABLE, has no default
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'user_settings'
--    AND column_name = 'recommend_stores_enabled';
-- -- expect: 1 row, boolean, YES, (null)
--
-- -- 2. All existing rows are NULL (treated as OFF)
-- SELECT COUNT(*) AS total,
--        COUNT(*) FILTER (WHERE recommend_stores_enabled IS NULL) AS as_null
--   FROM user_settings;
-- -- expect: total = as_null  (every existing user_settings row has NULL)
--
-- -- 3. Verify enum-ish behavior — only true/false/NULL accepted
-- --    (BOOLEAN type is naturally enforced; sanity check:)
-- INSERT INTO user_settings (user_id, recommend_stores_enabled)
-- VALUES (gen_random_uuid(), 'invalid-string');
-- -- expect: ERROR — invalid input syntax for type boolean
-- --         (then run: ROLLBACK; — do NOT commit this test row)
--
-- */
