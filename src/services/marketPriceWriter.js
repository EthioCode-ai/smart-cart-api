// src/services/marketPriceWriter.js
// ============================================================
// Transactional orchestrator for market_prices writes.
//
// Owns:
//   - market_prices       (the moat — regionalized prices)
//   - market_prices_pending (quarantine for low-confidence / un-corroborated)
//   - market_prices_history (append-only audit log)
//
// Does NOT touch:
//   - products       (metadata; handled by route)
//   - store_prices   (per-store; handled by route)
//
// Concurrency: every write runs in a transaction with SELECT ... FOR UPDATE
// on the matching zone row. Two concurrent scanners against the same zone
// will serialize; the second sees the first's update inside its own txn.
//
// Invariant: this module never sweeps existing rows. Flipping
// MIN_CORROBORATING_SCANS in the validator only affects future writes —
// rows already promoted under N=1 stay promoted. Do NOT add a re-validation
// pass over historical data without explicit product sign-off.
// ============================================================

const { transaction } = require('../models/db');
const { validatePriceWrite, DEFAULTS } = require('../utils/priceValidator');

const ZONE_RADIUS_KM = 80.5; // 50 miles
const CORROBORATION_PRICE_TOLERANCE = 0.05; // 5% — two scans of effectively-the-same price

// Haversine distance fragment, parameterized on $lat ($latIdx) and $lng ($lngIdx).
// Reads from anchor_latitude/anchor_longitude (immutable zone center) with a
// fallback to latitude/longitude for any row not yet backfilled.
const haversineKm = (latIdx, lngIdx) => `
  (6371 * acos(
    LEAST(1.0, GREATEST(-1.0,
      cos(radians($${latIdx})) * cos(radians(COALESCE(anchor_latitude, latitude))) *
      cos(radians(COALESCE(anchor_longitude, longitude)) - radians($${lngIdx})) +
      sin(radians($${latIdx})) * sin(radians(COALESCE(anchor_latitude, latitude)))
    ))
  ))`;

/**
 * Write a scanned price to the moat.
 *
 * @param {Object} payload
 * @param {string} payload.barcode
 * @param {number} payload.price
 * @param {number} [payload.unitPrice]
 * @param {number} [payload.regularPrice]
 * @param {number} payload.latitude          - scanner's current location
 * @param {number} payload.longitude
 * @param {string} [payload.source]
 * @param {string} [payload.scannedBy]       - user UUID, may be null for anon
 * @param {number} [payload.confidence]      - 0-1 from GPT Vision; required for camera sources
 *
 * @returns {Promise<{
 *   decision: 'accept'|'quarantine'|'reject'|'promoted',
 *   reason: string,
 *   marketPriceId?: string,
 *   pendingId?: string,
 *   partnerId?: string
 * }>}
 */
async function writeMarketPrice(payload) {
  const { barcode, price, latitude, longitude } = payload;

  if (!barcode || !isFiniteNumber(price) || !isFiniteNumber(latitude) || !isFiniteNumber(longitude)) {
    return { decision: 'reject', reason: 'missing_required_fields' };
  }

  return transaction(async (client) => {
    const existing = await findZoneForUpdate(client, payload);

    const validation = validatePriceWrite({
      barcode,
      price,
      confidence: payload.confidence,
      source: payload.source,
      existingMarketPrice: existing,
    });

    if (validation.decision === 'reject') {
      console.warn(`[marketPriceWriter] REJECT barcode=${barcode} price=${price} reason=${validation.reason}`);
      return { decision: 'reject', reason: validation.reason };
    }

    if (validation.decision === 'quarantine') {
      // Awaiting-corroboration writes look for a partner; low-confidence ones don't
      // (two uncertain reads don't make either correct).
      if (validation.reason === 'awaiting_corroboration') {
        const partner = await findPendingPartner(client, payload);
        if (partner) {
          const result = await applyAcceptedWrite(client, payload, existing, 'promoted_from_pending');
          await client.query('DELETE FROM market_prices_pending WHERE id = $1', [partner.id]);
          console.warn(`[marketPriceWriter] PROMOTED barcode=${barcode} price=${price} partnerId=${partner.id}`);
          return {
            decision: 'promoted',
            reason: 'corroboration_met',
            marketPriceId: result.marketPriceId,
            partnerId: partner.id,
          };
        }
      }
      const pendingId = await insertPending(client, payload, existing?.id, validation.reason);
      console.warn(`[marketPriceWriter] QUARANTINE barcode=${barcode} price=${price} reason=${validation.reason} pendingId=${pendingId}`);
      return { decision: 'quarantine', reason: validation.reason, pendingId };
    }

    // accept
    const result = await applyAcceptedWrite(client, payload, existing, existing ? 'update' : 'insert');
    return { decision: 'accept', reason: 'ok', marketPriceId: result.marketPriceId };
  });
}

// ── helpers ───────────────────────────────────────────────────────────────

const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

async function findZoneForUpdate(client, { barcode, latitude, longitude }) {
  const sql = `
    SELECT id, price, scan_count, anchor_latitude, anchor_longitude
      FROM market_prices
     WHERE barcode = $1
       AND ${haversineKm(2, 3)} < $4
     ORDER BY ${haversineKm(2, 3)} ASC
     LIMIT 1
     FOR UPDATE`;
  const result = await client.query(sql, [barcode, latitude, longitude, ZONE_RADIUS_KM]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    price: parseFloat(row.price),
    scan_count: row.scan_count,
    anchor_latitude: row.anchor_latitude,
    anchor_longitude: row.anchor_longitude,
  };
}

async function findPendingPartner(client, payload) {
  const { barcode, price, scannedBy } = payload;
  // Same barcode, similar price, recent, NOT same logged-in user.
  // Anonymous (NULL scanned_by) can corroborate anyone.
  //
  // TODO(post-launch, when MIN_CORROBORATING_SCANS flips to 2):
  // Add a `trusted_users` whitelist (admins / power scanners) who bypass the
  // different-user requirement. Otherwise a single trusted operator's two
  // scans of the same item can never corroborate themselves, blocking
  // legitimate writes during the early-N=2 window when the user base is small.
  const sql = `
    SELECT id, scanned_by
      FROM market_prices_pending
     WHERE barcode = $1
       AND quarantine_reason = 'awaiting_corroboration'
       AND $2 > 0
       AND ABS(price - $2) / $2 <= $3
       AND created_at > NOW() - INTERVAL '${DEFAULTS.corroborationFreshnessHours} hours'
       AND (scanned_by IS NULL OR $4::uuid IS NULL OR scanned_by != $4::uuid)
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`;
  const result = await client.query(sql, [
    barcode,
    price,
    CORROBORATION_PRICE_TOLERANCE,
    scannedBy || null,
  ]);
  return result.rows[0] || null;
}

async function applyAcceptedWrite(client, payload, existing, eventType) {
  const {
    barcode, price, unitPrice, regularPrice,
    latitude, longitude, source, scannedBy, confidence,
  } = payload;

  if (existing) {
    // UPDATE: anchor_* untouched (immutable zone center); rolling fields refresh.
    const previousPrice = existing.price;
    await client.query(
      `UPDATE market_prices SET
         price            = $1,
         unit_price       = $2,
         regular_price    = $3,
         latitude         = $4,
         longitude        = $5,
         scan_count       = scan_count + 1,
         confidence_avg   = CASE
           WHEN $6::numeric IS NULL THEN confidence_avg
           WHEN confidence_avg IS NULL THEN $6
           ELSE ((confidence_avg * scan_count) + $6) / (scan_count + 1)
         END,
         last_scanned_at  = NOW(),
         scanned_by       = $7,
         source           = $8,
         updated_at       = NOW()
       WHERE id = $9`,
      [price, unitPrice || null, regularPrice || null, latitude, longitude,
       confidence ?? null, scannedBy || null, source || null, existing.id]
    );
    await insertHistory(client, {
      market_price_id: existing.id,
      event_type: eventType,                         // 'update' or 'promoted_from_pending'
      barcode, price, previous_price: previousPrice,
      latitude, longitude, source, scanned_by: scannedBy, confidence,
      reason: eventType === 'promoted_from_pending' ? 'corroboration_met' : 'ok',
    });
    return { marketPriceId: existing.id };
  }

  // INSERT new zone — anchor_* set ONCE here and never updated.
  const insertResult = await client.query(
    `INSERT INTO market_prices
       (barcode, price, unit_price, regular_price,
        latitude, longitude,
        anchor_latitude, anchor_longitude,
        scan_count, confidence_avg,
        first_scanned_at, last_scanned_at,
        source, scanned_by)
     VALUES ($1, $2, $3, $4,
             $5, $6,
             $5, $6,
             1, $7,
             NOW(), NOW(),
             $8, $9)
     RETURNING id`,
    [barcode, price, unitPrice || null, regularPrice || null,
     latitude, longitude,
     confidence ?? null, source || null, scannedBy || null]
  );
  const newId = insertResult.rows[0].id;
  await insertHistory(client, {
    market_price_id: newId,
    event_type: eventType,                         // 'insert' or 'promoted_from_pending'
    barcode, price, previous_price: null,
    latitude, longitude, source, scanned_by: scannedBy, confidence,
    reason: eventType === 'promoted_from_pending' ? 'corroboration_met' : 'ok',
  });
  return { marketPriceId: newId };
}

async function insertPending(client, payload, existingMarketPriceId, reason) {
  const {
    barcode, price, unitPrice, regularPrice,
    latitude, longitude, source, scannedBy, confidence,
  } = payload;
  const result = await client.query(
    `INSERT INTO market_prices_pending
       (barcode, price, unit_price, regular_price,
        latitude, longitude,
        source, scanned_by, confidence,
        quarantine_reason, existing_market_price_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [barcode, price, unitPrice || null, regularPrice || null,
     latitude, longitude,
     source || null, scannedBy || null, confidence ?? null,
     reason, existingMarketPriceId || null]
  );
  return result.rows[0].id;
}

async function insertHistory(client, h) {
  await client.query(
    `INSERT INTO market_prices_history
       (market_price_id, event_type, barcode, price, previous_price,
        latitude, longitude, source, scanned_by, confidence, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [h.market_price_id, h.event_type, h.barcode, h.price, h.previous_price,
     h.latitude, h.longitude,
     h.source || null, h.scanned_by || null, h.confidence ?? null, h.reason]
  );
}

/**
 * Manually promote a pending row to market_prices, bypassing validation.
 * Used by the admin endpoint when an operator approves a quarantined scan.
 *
 * @param {string} pendingId
 * @returns {Promise<{ promoted: boolean, marketPriceId?: string, reason?: string }>}
 */
async function promotePending(pendingId) {
  return transaction(async (client) => {
    const pendingResult = await client.query(
      `SELECT * FROM market_prices_pending WHERE id = $1 FOR UPDATE`,
      [pendingId]
    );
    if (pendingResult.rows.length === 0) {
      return { promoted: false, reason: 'not_found' };
    }
    const p = pendingResult.rows[0];

    const payload = {
      barcode: p.barcode,
      price: parseFloat(p.price),
      unitPrice: p.unit_price ? parseFloat(p.unit_price) : null,
      regularPrice: p.regular_price ? parseFloat(p.regular_price) : null,
      latitude: parseFloat(p.latitude),
      longitude: parseFloat(p.longitude),
      source: p.source,
      scannedBy: p.scanned_by,
      confidence: p.confidence != null ? parseFloat(p.confidence) : null,
    };

    const existing = await findZoneForUpdate(client, payload);
    const result = await applyAcceptedWrite(client, payload, existing, 'admin_override');
    await client.query('DELETE FROM market_prices_pending WHERE id = $1', [pendingId]);

    console.warn(`[marketPriceWriter] ADMIN_OVERRIDE pendingId=${pendingId} barcode=${payload.barcode} marketPriceId=${result.marketPriceId}`);
    return { promoted: true, marketPriceId: result.marketPriceId };
  });
}

module.exports = {
  writeMarketPrice,
  promotePending,
  // Exported for test instrumentation only — do not call from routes.
  __internals: { findZoneForUpdate, findPendingPartner, applyAcceptedWrite, insertPending, insertHistory },
};
