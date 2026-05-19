-- ============================================================
-- 2026_05_phase0_scan_metrics.sql
-- ============================================================
-- Phase 0 of the unified-scanner work: MEASUREMENT ONLY.
--
-- Backs the accuracy/ease instrumentation Avi green-lit 2026-05-19.
-- The existing scanners post one anonymized row per completed scan;
-- /api/scan-metrics/summary aggregates them into the guardrail
-- trip-wires (correction rate, median duration, median taps).
--
-- PII-SAFE BY DESIGN (aligns with the Sentry no-PII directive):
--   stores NO prices, product names, barcodes, images, or geo.
--   Only: source bucket, was-corrected boolean, correction kind,
--   correction MAGNITUDE (a percentage, never the value), timing,
--   tap count, app version. A row says "an OCR price read was off
--   by 23%, took 8.4s, 3 taps" — it cannot identify a product,
--   price, place, or person.
--
-- Idempotent. BEGIN/COMMIT.
--
-- Run:
--   psql $DATABASE_URL -f src/db/migrations/2026_05_phase0_scan_metrics.sql
--
-- Pre-flight:
--   \d users   -- 'id' UUID, FK target for user_id (nullable,
--                 ON DELETE SET NULL so metrics survive user deletion)
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS scan_metrics (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID         REFERENCES users(id) ON DELETE SET NULL,
  source           VARCHAR(16)  NOT NULL
    CHECK (source IN ('barcode', 'ocr_shelf', 'ocr_aisle')),
  was_corrected    BOOLEAN      NOT NULL,
  correction_kind  VARCHAR(16)
    CHECK (correction_kind IS NULL OR correction_kind IN ('price', 'name', 'both', 'aisle', 'department')),
  -- Magnitude only (|corrected - read| / read * 100). Never the
  -- price/name itself. NULL when not applicable (e.g. no correction,
  -- or a non-numeric field).
  correction_pct   NUMERIC(7,2),
  duration_ms      INTEGER      NOT NULL CHECK (duration_ms >= 0),
  tap_count        INTEGER      NOT NULL CHECK (tap_count >= 0),
  app_version      VARCHAR(16),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Summary endpoint filters/aggregates by source over a recent window;
-- this index serves "recent rows, grouped by source".
CREATE INDEX IF NOT EXISTS idx_scan_metrics_source_time
  ON scan_metrics (source, created_at DESC);

COMMIT;

-- ============================================================
-- SMOKE CHECKS (paste after the migration completes)
-- ============================================================
-- /*
--
-- -- 1. Table + columns
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'scan_metrics' ORDER BY ordinal_position;
-- -- expect: id uuid NO; user_id uuid YES; source varchar NO;
-- --         was_corrected boolean NO; correction_kind varchar YES;
-- --         correction_pct numeric YES; duration_ms integer NO;
-- --         tap_count integer NO; app_version varchar YES;
-- --         created_at timestamptz NO
--
-- -- 2. source CHECK rejects junk
-- INSERT INTO scan_metrics (source, was_corrected, duration_ms, tap_count)
-- VALUES ('bogus', false, 100, 1);
-- -- expect: ERROR new row violates check constraint
--
-- -- 3. FK is ON DELETE SET NULL (metrics survive user deletion)
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid = 'scan_metrics'::regclass AND contype = 'f';
-- -- expect: ... REFERENCES users(id) ON DELETE SET NULL
--
-- -- 4. index present
-- SELECT indexname FROM pg_indexes WHERE tablename = 'scan_metrics';
-- -- expect: scan_metrics_pkey, idx_scan_metrics_source_time
--
-- */
