-- ============================================================
-- 2026_05_phase2_allergen_overrides.sql
-- ============================================================
-- Track 2 commit 9: allergen-override state machine.
--
-- Backs the "3x-in / 3x-out" override (locked 2026-05-05). When a
-- household has an allergen recorded, Recommend-a-Store's per-item
-- tagging strikes through matching items. If the user buys a struck
-- item repeatedly anyway, the override "normalizes" it (stops the
-- strikethrough for that specific item+allergen) — the user has
-- demonstrated this particular product is fine for their household.
--
-- v1 ships 3x-IN only:
--   strikethrough --[purchase_count >= 3]--> normalized  (count reset to 0)
-- 3x-OUT (normalized --> strikethrough on repeated non-purchase) is
-- DEFERRED to v1.1: it needs a reliable non-purchase signal, which
-- only arrives with receipt scanning. The non_purchase_count column
-- is intentionally left commented below as the v1.1 hook so the
-- shape is documented but the column doesn't exist until needed.
--
-- Keying: (user_id, item_match_key, allergen). Per-ITEM, not
-- per-allergen — overriding milk for 'dairy' must NOT normalize
-- yogurt for 'dairy'. item_match_key in v1 is lower(trim(name))
-- for non-barcoded items, barcode for barcoded. Brittle but
-- acceptable; worst case is one extra strikethrough. Fuzzy match
-- is a v1.1 refinement.
--
-- DORMANT IN v1: nothing writes to this table until products.allergens
-- is populated (v1.1). The migration ships now so the shape is locked
-- and commit 10/11 scaffolding has a target. See project memory
-- 'project_allergen_overrides'.
--
-- Idempotent. Wrapped in BEGIN/COMMIT.
--
-- Run:
--   psql $DATABASE_URL -f src/db/migrations/2026_05_phase2_allergen_overrides.sql
--
-- Pre-flight before running:
--   \d users   -- 'id' is UUID (FK target for user_id); confirmed
--                 via earlier schema dumps. ON DELETE CASCADE so
--                 deleting a user cleans up their overrides.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS allergen_overrides (
  user_id           UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_match_key    TEXT         NOT NULL,
  allergen          TEXT         NOT NULL,
  purchase_count    INTEGER      NOT NULL DEFAULT 0,
  -- non_purchase_count INTEGER  NOT NULL DEFAULT 0,
  --   ^^ v1.1 hook for 3x-OUT (normalized -> strikethrough). Stays
  --      commented until receipt scanning provides a non-purchase
  --      signal. Adding it later is a one-line ALTER; building the
  --      3x-out logic against a phantom column now is not.
  current_state     VARCHAR(16)  NOT NULL DEFAULT 'strikethrough'
    CHECK (current_state IN ('strikethrough', 'normalized')),
  state_changed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_purchased_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, item_match_key, allergen)
);

-- No extra index needed: the only access patterns are
--   (a) write-path upsert on the full PK, and
--   (b) engine read "all overrides for this user" — WHERE user_id = $1
--       is a left-prefix of the composite PK, so the PK btree serves it.

COMMIT;

-- ============================================================
-- SMOKE CHECKS (paste after the migration completes)
-- ============================================================
-- /*
--
-- -- 1. Table exists with the expected columns/types
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'allergen_overrides'
--  ORDER BY ordinal_position;
-- -- expect: user_id uuid NO; item_match_key text NO; allergen text NO;
-- --         purchase_count integer NO 0; current_state varchar NO
-- --         'strikethrough'::character varying; state_changed_at
-- --         timestamptz NO now(); last_purchased_at timestamptz YES
-- -- expect: NO non_purchase_count column (v1.1 hook stays commented)
--
-- -- 2. Composite PK
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'allergen_overrides'::regclass AND contype = 'p';
-- -- expect: allergen_overrides_pkey | PRIMARY KEY (user_id, item_match_key, allergen)
--
-- -- 3. current_state CHECK constraint
-- SELECT pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'allergen_overrides'::regclass AND contype = 'c';
-- -- expect: CHECK ((current_state::text = ANY (ARRAY['strikethrough'::character varying,
-- --         'normalized'::character varying]::text[])))
--
-- -- 4. FK to users with ON DELETE CASCADE
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'allergen_overrides'::regclass AND contype = 'f';
-- -- expect: ... FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
--
-- -- 5. CHECK actually rejects bad states
-- INSERT INTO allergen_overrides (user_id, item_match_key, allergen, current_state)
-- VALUES ((SELECT id FROM users LIMIT 1), 'smoke-test-key', 'dairy', 'bogus');
-- -- expect: ERROR — new row violates check constraint
-- --         (then: DELETE FROM allergen_overrides WHERE item_match_key = 'smoke-test-key';
-- --          to clean any valid test rows — do NOT leave smoke rows)
--
-- */
