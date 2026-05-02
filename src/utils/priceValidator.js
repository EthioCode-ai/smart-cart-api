// src/utils/priceValidator.js
// ============================================================
// Pure validation function for market_prices writes.
// No DB access; safe to unit-test in isolation.
//
// Per-barcode comparison: `existingMarketPrice` is the row matching THIS
// barcode (same UPC/SKU). Different products at different prices in the
// same area live in separate market_prices rows and never compare here.
// e.g. a $12 wine and a $45 wine are different barcodes → different rows.
//
// Bounds violation is the only HARD REJECT. Everything else suspicious
// gets quarantined to market_prices_pending — never silently dropped.
// ============================================================

const DEFAULTS = {
  // Common-sense grocery price range. Catches OCR disasters like a
  // misplaced decimal ($5.79 → $57.99 still passes; $5.79 → $579 doesn't).
  priceMin: 0.10,
  priceMax: 500.00,

  // GPT Vision returns a 0-1 confidence score. Below this, quarantine.
  // 0.7 is conservative; can tune from production data.
  minVisionConfidence: 0.70,

  // Confidence is opt-in protection: when a camera-source scan arrives
  // WITHOUT a confidence field (older client, network hiccup, missing
  // /ocr-vision integration), we degrade to "assumed-good" rather than
  // silently quarantining every scan. 0.85 is above the gate threshold,
  // so missing → accept; only honest self-reported low confidence quarantines.
  // A malicious client could send 1.0 anyway, so quarantining-on-missing
  // wouldn't stop attacks — it would only hurt cooperative legacy clients.
  missingConfidenceDefault: 0.85,

  // |new - existing| / existing > this → quarantine pending corroboration.
  quarantineDeltaThreshold: 0.50,

  // 1 = launch mode: bypass delta check entirely (we're building the
  //     initial price database; quarantining everything would block all writes).
  // 2 = post-launch: require a second corroborating scan within freshness
  //     window before promoting a quarantined row.
  // Flip this constant when user count crosses ~50 active scanners.
  minCorroboratingScans: 1,

  // How long a quarantined "awaiting_corroboration" row stays eligible
  // for promotion. Older pending rows still reviewable via admin endpoint.
  corroborationFreshnessHours: 24,
};

// Sources that go through camera/OCR and SHOULD carry a confidence score.
// When confidence is missing, we use missingConfidenceDefault rather than
// quarantining — see DEFAULTS comment for rationale.
const CAMERA_SOURCES = new Set(['gpt_vision', 'walk_scan', 'list_scan']);

const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Decide whether a market_prices write should be accepted, quarantined, or rejected.
 *
 * @param {Object} input
 * @param {string} input.barcode
 * @param {number} input.price                  - the price the scanner read
 * @param {number} [input.confidence]           - 0-1; if absent on a camera source, treated as missingConfidenceDefault
 * @param {string} [input.source]               - 'gpt_vision' | 'walk_scan' | 'list_scan' | 'manual' | etc.
 * @param {Object} [input.existingMarketPrice]  - { price } for THIS barcode, or null/undefined
 * @param {Object} [config]                     - optional overrides for testing
 *
 * @returns {{ decision: 'accept'|'quarantine'|'reject', reason: string }}
 */
function validatePriceWrite(input, config) {
  const opts = { ...DEFAULTS, ...(config || {}) };
  const { price, confidence, source, existingMarketPrice } = input;

  // 1. Bounds — the only hard reject.
  if (!isFiniteNumber(price) || price < opts.priceMin || price > opts.priceMax) {
    return { decision: 'reject', reason: 'bounds_violation' };
  }

  // 2. Confidence — only enforced for camera-derived sources.
  // Missing confidence degrades to missingConfidenceDefault (assumed-good)
  // so older clients don't get every scan silently quarantined.
  if (CAMERA_SOURCES.has(source)) {
    const conf = isFiniteNumber(confidence) ? confidence : opts.missingConfidenceDefault;
    if (conf < opts.minVisionConfidence) {
      return { decision: 'quarantine', reason: 'low_confidence' };
    }
  }

  // 3. Delta vs existing price for THIS barcode.
  // Bypassed entirely when minCorroboratingScans = 1 (launch mode).
  if (
    opts.minCorroboratingScans >= 2 &&
    existingMarketPrice &&
    isFiniteNumber(existingMarketPrice.price) &&
    existingMarketPrice.price > 0
  ) {
    const delta = Math.abs(price - existingMarketPrice.price) / existingMarketPrice.price;
    if (delta > opts.quarantineDeltaThreshold) {
      return { decision: 'quarantine', reason: 'awaiting_corroboration' };
    }
  }

  return { decision: 'accept', reason: 'ok' };
}

module.exports = {
  validatePriceWrite,
  DEFAULTS,
  CAMERA_SOURCES,
};
