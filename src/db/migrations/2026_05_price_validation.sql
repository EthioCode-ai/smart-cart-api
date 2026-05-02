-- ============================================================
-- 2026_05_price_validation.sql
-- ============================================================
-- Hardens the market_prices write path:
--   1. Anchor zones to first-scan coordinates (stops boundary drift)
--   2. Track scan_count + confidence_avg per zone (trust signal)
--   3. Quarantine table for low-confidence / awaiting-corroboration writes
--   4. Append-only audit log for rollback + abuse forensics
--
-- Run via:  psql $DATABASE_URL -f src/db/migrations/2026_05_price_validation.sql
-- Idempotent: safe to re-run; uses IF NOT EXISTS / IF NOT EXISTS COLUMN.
--
-- Note on zone uniqueness: PostgreSQL has no built-in "unique within
-- Haversine distance" constraint. Race conditions between concurrent
-- scanners are handled at the application layer in marketPriceWriter.js
-- via SELECT ... FOR UPDATE inside a transaction.
-- ============================================================

BEGIN;

-- ── 1. Anchor zones (IMMUTABLE first-scan location) ─────────────────────────
-- The existing latitude/longitude columns previously moved on every price
-- update, causing zone boundaries to drift. From now on, anchor_* is the
-- canonical zone center used for the 50-mile radius check, and is set once
-- on first INSERT then never changed.
-- Nullable for now (safe backfill); a future migration can tighten to NOT NULL
-- once we've verified zero NULLs after the marketPriceWriter has been live.
ALTER TABLE market_prices
  ADD COLUMN IF NOT EXISTS anchor_latitude  NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS anchor_longitude NUMERIC(9,6);

UPDATE market_prices
   SET anchor_latitude  = latitude,
       anchor_longitude = longitude
 WHERE anchor_latitude IS NULL
    OR anchor_longitude IS NULL;

CREATE INDEX IF NOT EXISTS idx_market_prices_anchor
  ON market_prices (anchor_latitude, anchor_longitude);

-- ── 2. Trust signals on each zone ───────────────────────────────────────────
ALTER TABLE market_prices
  ADD COLUMN IF NOT EXISTS scan_count       INTEGER     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS confidence_avg   NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS first_scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_scanned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ── 3. Pending writes ───────────────────────────────────────────────────────
-- Quarantine table for scans that fail confidence or corroboration checks.
-- Promoted into market_prices once corroboration is met (or admin approves).
CREATE TABLE IF NOT EXISTS market_prices_pending (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  barcode                  VARCHAR(64)   NOT NULL,
  price                    NUMERIC(10,2) NOT NULL,
  unit_price               NUMERIC(10,2),
  regular_price            NUMERIC(10,2),
  latitude                 NUMERIC(9,6)  NOT NULL,
  longitude                NUMERIC(9,6)  NOT NULL,
  source                   VARCHAR(32),
  scanned_by               UUID          REFERENCES users(id) ON DELETE SET NULL,
  confidence               NUMERIC(3,2),
  quarantine_reason        VARCHAR(32)   NOT NULL,
    -- 'low_confidence' | 'awaiting_corroboration' | 'admin_review'
  existing_market_price_id UUID          REFERENCES market_prices(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_barcode_recent
  ON market_prices_pending (barcode, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_reason
  ON market_prices_pending (quarantine_reason, created_at DESC);

-- ── 4. Append-only audit log ────────────────────────────────────────────────
-- Records every market_prices INSERT/UPDATE for rollback + forensics.
-- Never UPDATE'd or DELETE'd from application code.
CREATE TABLE IF NOT EXISTS market_prices_history (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  market_price_id UUID          NOT NULL,
  event_type      VARCHAR(32)   NOT NULL,
    -- 'insert' | 'update' | 'promoted_from_pending' | 'admin_override' | 'rollback'
  barcode         VARCHAR(64)   NOT NULL,
  price           NUMERIC(10,2) NOT NULL,
  previous_price  NUMERIC(10,2),
  latitude        NUMERIC(9,6),
  longitude       NUMERIC(9,6),
  source          VARCHAR(32),
  scanned_by      UUID,
  confidence      NUMERIC(3,2),
  reason          VARCHAR(64),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_history_barcode_time
  ON market_prices_history (barcode, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_history_market_price
  ON market_prices_history (market_price_id, created_at DESC);

COMMIT;
