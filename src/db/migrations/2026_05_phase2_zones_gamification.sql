-- ============================================================
-- 2026_05_phase2_zones_gamification.sql
-- ============================================================
-- Phase 2 PR 1: aisle_side support, PACS stale tracking,
-- anti-fraud signals, and price-side gamification rewards.
--
-- This migration is INTENTIONALLY MINIMAL. The codebase already has
-- substantial gamification + layout infrastructure that the early
-- launch-plan documentation omitted. After auditing the live schema:
--
--   ALREADY EXISTS — do NOT recreate:
--     point_transactions  (audit log, replaces my proposed 'points_history')
--     point_values        (configurable rewards, already seeded)
--     user_points         (denormalized totals + level + streak_days)
--     user_badges         (already exists; UNIQUE(user_id, badge_type, store_id))
--     level_thresholds    (10 themed tiers from Shopper to Legend)
--     layout_contributions (per-action audit + status pending/approved/rejected/flagged
--                          — replaces both my proposed 'pending' and 'history' tables)
--     aisle_departments   (junction with per-department confidence_score)
--     aisle_products      (Phase 3's product->aisle prediction is a JOIN, not new code)
--     store_entrances     (dedicated entrance/exit table, 18 zone types)
--     store_layout_stats  (already aggregates avg_confidence per store = store-level SACS)
--     store_layout        (cached JSONB layout)
--     store_contributions (video-walkthrough mapping mode)
--     department_reference (canonical names + aliases for normalizing GPT Vision output)
--
--   THIS MIGRATION ADDS (truly new):
--     1. aisle_side       on store_aisles  (split-side aisles, e.g. Walmart 14)
--     2. UNIQUE constraint update          (allows two rows per aisle for sides)
--     3. flag_stale_count on market_prices (PACS stale_penalty input)
--     4. fraud_signals    table             (anti-fraud Layer 2 passive log)
--     5. device_fingerprint on users        (anti-fraud Layer 2 input)
--     6. Extended point_transactions.reason CHECK to allow price-side actions
--     7. Seeded 3 new rows in point_values for price-side gamification
--
-- Idempotent. Wrapped in BEGIN/COMMIT.
-- Run via: psql $DATABASE_URL -f src/db/migrations/2026_05_phase2_zones_gamification.sql
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────
-- 1. aisle_side on store_aisles
-- ────────────────────────────────────────────────────────────────
-- Walmart-style: aisle 14 might be 'chips' on north side and 'cookies' on south.
-- Two rows in store_aisles, same (store_id, aisle_number), different aisle_side.
-- NULL means whole-aisle (one department spans both sides).
ALTER TABLE store_aisles
  ADD COLUMN IF NOT EXISTS aisle_side VARCHAR(16);
    -- 'north' | 'south' | 'east' | 'west' | NULL (whole aisle)

-- ────────────────────────────────────────────────────────────────
-- 2. Relax UNIQUE constraint to allow per-side rows
-- ────────────────────────────────────────────────────────────────
-- Existing: UNIQUE(store_id, aisle_number)
-- New:      UNIQUE(store_id, aisle_number, aisle_side) NULLS NOT DISTINCT
-- NULLS NOT DISTINCT (PG 15+) treats two NULL aisle_sides as the same value,
-- so an aisle without sides still has only one row.
ALTER TABLE store_aisles
  DROP CONSTRAINT IF EXISTS store_aisles_store_id_aisle_number_key;

ALTER TABLE store_aisles
  ADD CONSTRAINT store_aisles_store_id_aisle_number_side_key
  UNIQUE NULLS NOT DISTINCT (store_id, aisle_number, aisle_side);

-- ────────────────────────────────────────────────────────────────
-- 3. PACS stale tracking on market_prices
-- ────────────────────────────────────────────────────────────────
-- Drives the stale_penalty term in PACS computation: 5 stale flags = score 0.
-- Incremented when a user reports a price as stale; decremented on re-confirm.
ALTER TABLE market_prices
  ADD COLUMN IF NOT EXISTS flag_stale_count INTEGER NOT NULL DEFAULT 0;

-- ────────────────────────────────────────────────────────────────
-- 4. fraud_signals (passive abuse detection log)
-- ────────────────────────────────────────────────────────────────
-- Layer 2 of anti-fraud per the Phase 2 design: log suspicious patterns
-- without enforcing yet. Admin tools (Layer 3) review and act.
-- ON DELETE SET NULL on user_id preserves forensic trail if user is removed.
CREATE TABLE IF NOT EXISTS fraud_signals (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         REFERENCES users(id) ON DELETE SET NULL,
  signal_type  VARCHAR(64)  NOT NULL,
    -- 'high_confirmation_rate' | 'low_diversity' | 'geofence_violation_attempt'
    -- | 'multi_account_suspicion' | 'rapid_action_burst' | 'point_velocity_anomaly'
  details      JSONB,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fraud_user_recent
  ON fraud_signals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_type_recent
  ON fraud_signals (signal_type, created_at DESC);

-- ────────────────────────────────────────────────────────────────
-- 5. device_fingerprint on users (anti-fraud Layer 2 input)
-- ────────────────────────────────────────────────────────────────
-- Best-effort device ID from Application.androidId / iOS IDFV. Used for
-- multi-account detection cross-correlation. Imperfect (iOS resets on
-- reinstall) but useful as one signal among many.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS device_fingerprint VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_users_device_fp
  ON users (device_fingerprint)
  WHERE device_fingerprint IS NOT NULL;

-- ────────────────────────────────────────────────────────────────
-- 6. Extend point_transactions.reason CHECK to allow price-side actions
-- ────────────────────────────────────────────────────────────────
-- Existing CHECK only allowed layout-side reasons. PACS gamification
-- requires price-side reasons too. Drop the old constraint, add new
-- with all existing values preserved + 3 new ones.
ALTER TABLE point_transactions
  DROP CONSTRAINT IF EXISTS point_transactions_reason_check;

ALTER TABLE point_transactions
  ADD CONSTRAINT point_transactions_reason_check
  CHECK (reason::text = ANY (ARRAY[
    -- Existing layout-side reasons (preserved verbatim)
    'aisle_scan'::varchar,
    'aisle_manual'::varchar,
    'aisle_confirm'::varchar,
    'data_report'::varchar,
    'entrance_map'::varchar,
    'first_store_bonus'::varchar,
    'store_complete_bonus'::varchar,
    'streak_bonus'::varchar,
    'weekly_challenge'::varchar,
    -- New price-side reasons (PACS gamification)
    'price_scan'::varchar,
    'price_confirm'::varchar,
    'price_stale_report'::varchar
  ]::text[]));

-- ────────────────────────────────────────────────────────────────
-- 7. Seed price-side point values
-- ────────────────────────────────────────────────────────────────
-- Calibrated to existing layout-side ratios:
--   aisle_scan(50) : aisle_confirm(10) = 5:1     -> price_scan : price_confirm = 5:1
--   aisle_scan(50) : data_report(15)   = 3.3:1   -> price_scan : price_stale_report ~3:1
--
-- Lower per-event than aisle_scan because price scanning is high-frequency
-- (30+ items per shopping trip vs ~30 aisles per store mapped once).
-- 30-trip user earning 30*10 = 300 pts is balanced against 30-aisle
-- mapper earning 30*50 = 1500 pts (one-time vs recurring).
INSERT INTO point_values (action, points, description) VALUES
  ('price_scan',         10, 'Scan a shelf price tag with camera (new price)'),
  ('price_confirm',      2,  'Confirm existing price is still accurate'),
  ('price_stale_report', 5,  'Report a stale price (validated by another user)')
ON CONFLICT (action) DO NOTHING;

COMMIT;
