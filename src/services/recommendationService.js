// src/services/recommendationService.js
// ============================================================
// Recommend-a-Store orchestrator (Track 2 commit 6).
//
// Composes:
//   - candidate store discovery (Haversine pre-filter)
//   - basket pricing per store (3-tier substitution: exact name,
//     barcode, trigram + PACS + price band)
//   - drive-time enrichment via driveTimeService
//   - ranking + banner-trigger logic
//
// SUBSTITUTION DESIGN (locked 2026-05-04):
//   Population data showed only 4/312 list items have barcodes —
//   voice/text-added is the dominant input pattern. Category-based
//   substitution was retired. v1 priority is name-first:
//
//     Tier 1: exact name match (LOWER(p.name) = LOWER(item.name))
//     Tier 2: barcode match (when item.barcode present)
//     Tier 3: trigram similarity > 0.7 AND PACS >= 0.40 AND
//             staleness < 45 days AND ±30% unit-price band
//
//   Substitution score (for picking best Tier-3 match):
//     similarity * pacs * log10(scan_count + 10) * recency_decay
//   where recency_decay = exp(-days_since_updated / 30).
//
//   The ±30% band's "target" is the exact-name match price at
//   any candidate store — the strongest available reference. If
//   no exact-name hit exists across candidates, the band check
//   is skipped (trigram + PACS still gate).
//
// CACHE:
//   In-memory Map keyed on (list_id|list_version|lat_bucket|lng_bucket),
//   15-min TTL. Single-instance Render is the assumption; a
//   DB-backed cache can replace this when we scale horizontally.
//
// PACS NORMALIZATION:
//   store_prices.confidence is the per-row trust signal. Some
//   write paths use 0–1 (GPT vision), others use 0–100 (legacy
//   layout convention). We normalize: > 1 → divide by 100, NULL
//   → 0.5 (medium). The 0.40 gate applies to the normalized value.
// ============================================================

const { query } = require('../models/db');
const driveTimeService = require('./driveTimeService');

// ── Constants ──────────────────────────────────────────────
const DEFAULT_RADIUS_KM = 8;
const DEFAULT_CANDIDATE_LIMIT = 5;
const STALENESS_DAYS = 45;
const PACS_GATE = 0.40;
const TRIGRAM_THRESHOLD = 0.7;
const PRICE_BAND_FACTOR = 0.30;        // ±30%
const CACHE_TTL_MS = 15 * 60 * 1000;   // 15 min

// Banner trigger thresholds
const BANNER_MIN_SAVINGS_USD = 10;
const BANNER_MIN_SAVINGS_RATIO = 0.10; // 10% of basket
const BANNER_MAX_DRIVE_RATIO = 2.0;    // alternative drive <= 2x preferred
const BANNER_MAX_DRIVE_ABS_MIN = 5;    // OR <= 5 min absolute extra

// ── Cache ──────────────────────────────────────────────────
const _cache = new Map();

function _bucketCoord(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Number(value).toFixed(2); // ~1km granularity for the rec cache
}

function _cacheKey({ listId, listVersion, userLat, userLng }) {
  return `${listId}|${listVersion}|${_bucketCoord(userLat)}|${_bucketCoord(userLng)}`;
}

function _cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}

function _cachePut(key, value) {
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function clearCache() {
  _cache.clear();
}

// ── Helpers ────────────────────────────────────────────────
function _normalizePacs(raw) {
  if (raw === null || raw === undefined) return 0.5;
  const v = parseFloat(raw);
  if (Number.isNaN(v)) return 0.5;
  return v > 1 ? v / 100 : v;
}

function _recencyDecay(updatedAt) {
  if (!updatedAt) return 0.5;
  const days = (Date.now() - new Date(updatedAt).getTime()) / 86400000;
  return Math.exp(-days / 30);
}

function _substitutionScore({ similarity, pacs, scanCount, updatedAt }) {
  const sc = Math.max(scanCount || 1, 1);
  return similarity * pacs * Math.log10(sc + 10) * _recencyDecay(updatedAt);
}

// ── Query A: candidate stores by Haversine ────────────────
// Returns nearby stores, ordered by straight-line distance. Drive
// time comes later via driveTimeService — this is the cheap pre-filter.
async function getCandidateStores({ userLat, userLng, radiusKm = DEFAULT_RADIUS_KM, limit = DEFAULT_CANDIDATE_LIMIT }) {
  if (userLat === null || userLng === null || userLat === undefined || userLng === undefined) {
    return [];
  }
  const result = await query(
    `SELECT id, name, address, latitude, longitude,
            (6371 * acos(
              cos(radians($1)) * cos(radians(latitude)) *
              cos(radians(longitude) - radians($2)) +
              sin(radians($1)) * sin(radians(latitude))
            )) AS distance_km
       FROM stores
      WHERE latitude  IS NOT NULL
        AND longitude IS NOT NULL
        AND (6371 * acos(
              cos(radians($1)) * cos(radians(latitude)) *
              cos(radians(longitude) - radians($2)) +
              sin(radians($1)) * sin(radians(latitude))
            )) <= $3
      ORDER BY distance_km ASC
      LIMIT $4`,
    [userLat, userLng, radiusKm, limit]
  );
  return result.rows.map(r => ({
    id: r.id,
    name: r.name,
    address: r.address,
    lat: parseFloat(r.latitude),
    lng: parseFloat(r.longitude),
    distance_km: parseFloat(r.distance_km),
  }));
}

// ── Item match: 3-tier ─────────────────────────────────────
// Returns one of:
//   { matched: true,  tier: 1|2|3, price, unit_price, source, name_used, substitute? }
//   { matched: false }
async function matchItemAtStore({ item, storeId, referenceUnitPrice = null }) {
  const itemName = (item.name || '').trim();
  const lname = itemName.toLowerCase();

  // Tier 1: exact name match through products
  if (itemName) {
    const t1 = await query(
      `SELECT sp.price, sp.unit_price, sp.confidence, sp.updated_at,
              p.name AS product_name, p.barcode
         FROM products p
         JOIN store_prices sp
           ON sp.barcode = p.barcode AND sp.store_id = $1
        WHERE LOWER(p.name) = $2
          AND sp.price > 0
          AND sp.updated_at > NOW() - INTERVAL '${STALENESS_DAYS} days'
        ORDER BY sp.confidence DESC NULLS LAST, sp.updated_at DESC
        LIMIT 1`,
      [storeId, lname]
    );
    if (t1.rows[0]) {
      const r = t1.rows[0];
      return {
        matched: true,
        tier: 1,
        price: parseFloat(r.price),
        unit_price: r.unit_price !== null ? parseFloat(r.unit_price) : null,
        source: 'exact_name',
        name_used: r.product_name,
      };
    }
  }

  // Tier 2: barcode match (when present on the list item)
  if (item.barcode) {
    const t2 = await query(
      `SELECT sp.price, sp.unit_price, sp.confidence, sp.updated_at,
              p.name AS product_name
         FROM store_prices sp
         LEFT JOIN products p ON p.barcode = sp.barcode
        WHERE sp.barcode = $1
          AND sp.store_id = $2
          AND sp.price > 0
          AND sp.updated_at > NOW() - INTERVAL '${STALENESS_DAYS} days'
        LIMIT 1`,
      [item.barcode, storeId]
    );
    if (t2.rows[0]) {
      const r = t2.rows[0];
      return {
        matched: true,
        tier: 2,
        price: parseFloat(r.price),
        unit_price: r.unit_price !== null ? parseFloat(r.unit_price) : null,
        source: 'barcode',
        name_used: r.product_name || itemName,
      };
    }
  }

  // Tier 3: trigram + PACS gate (+ price band when reference available)
  if (!itemName) return { matched: false };
  const t3 = await query(
    `SELECT sp.price, sp.unit_price, sp.confidence, sp.updated_at,
            p.name AS product_name, p.barcode,
            similarity(LOWER(p.name), $2) AS sim
       FROM products p
       JOIN store_prices sp
         ON sp.barcode = p.barcode AND sp.store_id = $1
      WHERE similarity(LOWER(p.name), $2) > $3
        AND sp.price > 0
        AND sp.updated_at > NOW() - INTERVAL '${STALENESS_DAYS} days'
      ORDER BY sim DESC, sp.confidence DESC NULLS LAST
      LIMIT 10`,
    [storeId, lname, TRIGRAM_THRESHOLD]
  );
  if (t3.rows.length === 0) return { matched: false };

  // Apply PACS gate + optional ±30% price band; pick highest substitution score.
  let best = null;
  for (const r of t3.rows) {
    const pacs = _normalizePacs(r.confidence);
    if (pacs < PACS_GATE) continue;

    if (referenceUnitPrice !== null && r.unit_price !== null) {
      const up = parseFloat(r.unit_price);
      const lo = referenceUnitPrice * (1 - PRICE_BAND_FACTOR);
      const hi = referenceUnitPrice * (1 + PRICE_BAND_FACTOR);
      if (up < lo || up > hi) continue;
    }

    const score = _substitutionScore({
      similarity: parseFloat(r.sim),
      pacs,
      scanCount: 1, // store_prices doesn't carry scan_count; keep as no-op for v1
      updatedAt: r.updated_at,
    });
    if (!best || score > best._score) {
      best = {
        _score: score,
        matched: true,
        tier: 3,
        price: parseFloat(r.price),
        unit_price: r.unit_price !== null ? parseFloat(r.unit_price) : null,
        source: 'substitute',
        name_used: r.product_name,
        substitute: { from: itemName, to: r.product_name, similarity: parseFloat(r.sim) },
      };
    }
  }
  if (!best) return { matched: false };
  delete best._score;
  return best;
}

// ── Reference price discovery ──────────────────────────────
// To gate Tier-3 substitutions with the ±30% band, we need a target
// unit_price. The strongest signal is "what does an exact-name
// match cost?" — looked up at any store with stale-fresh data.
// Returns { itemKey: refUnitPrice, ... } for items that have one.
async function _buildReferenceUnitPrices(items) {
  const out = {};
  if (!items.length) return out;
  const names = items.map(i => (i.name || '').toLowerCase()).filter(Boolean);
  if (!names.length) return out;
  const result = await query(
    `SELECT LOWER(p.name) AS k, MIN(sp.unit_price) AS ref
       FROM products p
       JOIN store_prices sp ON sp.barcode = p.barcode
      WHERE LOWER(p.name) = ANY($1)
        AND sp.unit_price IS NOT NULL
        AND sp.unit_price > 0
        AND sp.updated_at > NOW() - INTERVAL '${STALENESS_DAYS} days'
      GROUP BY LOWER(p.name)`,
    [names]
  );
  for (const r of result.rows) {
    out[r.k] = parseFloat(r.ref);
  }
  return out;
}

// ── Query B: basket pricing per store ─────────────────────
// For one store, runs the 3-tier match for every list item, sums
// the prices, and reports per-item match metadata. Items the store
// can't fulfill are counted in missing_count.
async function priceBasketAtStore({ items, store, refPrices = {} }) {
  const lineItems = [];
  let totalCost = 0;
  let missingCount = 0;
  for (const item of items) {
    const refKey = (item.name || '').toLowerCase();
    const m = await matchItemAtStore({
      item,
      storeId: store.id,
      referenceUnitPrice: refPrices[refKey] ?? null,
    });
    if (m.matched) {
      const qty = parseFloat(item.quantity) || 1;
      const lineCost = m.price * qty;
      totalCost += lineCost;
      lineItems.push({
        list_item_id: item.id,
        name: item.name,
        quantity: qty,
        matched: true,
        tier: m.tier,
        source: m.source,
        name_used: m.name_used,
        unit_price: m.price,
        line_cost: Math.round(lineCost * 100) / 100,
        substitute: m.substitute || null,
      });
    } else {
      missingCount += 1;
      lineItems.push({
        list_item_id: item.id,
        name: item.name,
        quantity: parseFloat(item.quantity) || 1,
        matched: false,
      });
    }
  }
  return {
    store_id: store.id,
    store_name: store.name,
    store_address: store.address,
    total_cost: Math.round(totalCost * 100) / 100,
    missing_count: missingCount,
    matched_count: lineItems.length - missingCount,
    items: lineItems,
  };
}

// ── Banner trigger ─────────────────────────────────────────
// Returns { trigger: bool, savings, savings_ratio, drive_minutes_extra } for
// a given (preferred, alternative) basket pair. Trigger requires:
//   savings >= MAX($10, 10% of basket)  AND
//   alt drive <= 2x preferred  OR  alt drive <= preferred + 5 min
function evaluateBannerTrigger({ preferred, alternative }) {
  if (!preferred || !alternative) return { trigger: false };
  const savings = preferred.total_cost - alternative.total_cost;
  if (savings <= 0) return { trigger: false, savings };
  const ratio = preferred.total_cost > 0 ? savings / preferred.total_cost : 0;
  const minSavings = Math.max(BANNER_MIN_SAVINGS_USD, preferred.total_cost * BANNER_MIN_SAVINGS_RATIO);
  if (savings < minSavings) return { trigger: false, savings, savings_ratio: ratio };

  const prefMin = preferred.drive_minutes ?? null;
  const altMin = alternative.drive_minutes ?? null;
  if (prefMin === null || altMin === null) {
    // Without drive-time data we still let savings drive the trigger; caller can downgrade.
    return { trigger: true, savings, savings_ratio: ratio, drive_minutes_extra: null };
  }
  const extra = altMin - prefMin;
  const okByRatio = altMin <= prefMin * BANNER_MAX_DRIVE_RATIO;
  const okByAbsolute = extra <= BANNER_MAX_DRIVE_ABS_MIN;
  if (!(okByRatio || okByAbsolute)) {
    return { trigger: false, savings, savings_ratio: ratio, drive_minutes_extra: extra };
  }
  return { trigger: true, savings, savings_ratio: ratio, drive_minutes_extra: extra };
}

// ── Mode resolution ───────────────────────────────────────
// Reads users.default_store_id and partitions candidates into
// preferred vs. alternatives.
//   Mode A: user has no default → recommend the cheapest, explicit CTA
//   Mode B: user has a default that's also the cheapest → silent
//   Mode C: user has a default that's beaten → subtle FYI banner
async function _resolveMode({ userId, candidates }) {
  if (candidates.length === 0) return { mode: 'empty', preferred: null, alternative: null };

  const ranked = [...candidates].sort((a, b) => a.total_cost - b.total_cost);
  const cheapest = ranked[0];

  const userResult = await query(
    `SELECT default_store_id FROM users WHERE id = $1`,
    [userId]
  );
  const defaultStoreId = userResult.rows[0]?.default_store_id || null;

  if (!defaultStoreId) {
    return {
      mode: 'A',
      preferred: cheapest,
      alternative: ranked[1] || null,
    };
  }

  const defaultEntry = candidates.find(c => c.store_id === defaultStoreId);
  if (!defaultEntry) {
    // User's default store isn't in the candidate set (out of radius / no data).
    return { mode: 'A', preferred: cheapest, alternative: ranked[1] || null };
  }

  if (defaultEntry.store_id === cheapest.store_id) {
    return { mode: 'B', preferred: defaultEntry, alternative: ranked[1] || null };
  }

  return { mode: 'C', preferred: defaultEntry, alternative: cheapest };
}

// ── PUBLIC: getRecommendations ─────────────────────────────
async function getRecommendations({
  userId,
  listId,
  userLat,
  userLng,
  radiusKm = DEFAULT_RADIUS_KM,
  candidateLimit = DEFAULT_CANDIDATE_LIMIT,
  bypassCache = false,
} = {}) {
  if (!userId) throw new Error('userId required');
  if (!listId) throw new Error('listId required');

  // 1. Read list + version + items (single round trip)
  const listResult = await query(
    `SELECT sl.id, sl.list_version,
            COALESCE(json_agg(
              json_build_object(
                'id', li.id, 'name', li.name, 'quantity', li.quantity,
                'barcode', li.barcode, 'department', li.department,
                'price', li.price
              )
            ) FILTER (WHERE li.id IS NOT NULL), '[]') AS items
       FROM shopping_lists sl
       LEFT JOIN list_items li ON li.list_id = sl.id
      WHERE sl.id = $1 AND sl.user_id = $2
      GROUP BY sl.id, sl.list_version`,
    [listId, userId]
  );
  if (listResult.rows.length === 0) {
    throw new Error('list not found');
  }
  const list = listResult.rows[0];
  const items = list.items;
  const listVersion = list.list_version ?? 0;

  // 2. Cache lookup
  const key = _cacheKey({ listId, listVersion, userLat, userLng });
  if (!bypassCache) {
    const hit = _cacheGet(key);
    if (hit) return { ...hit, cache_hit: true };
  }

  // 3. Candidate stores via Haversine
  const stores = await getCandidateStores({ userLat, userLng, radiusKm, limit: candidateLimit });
  if (stores.length === 0) {
    const empty = {
      list_id: listId,
      list_version: listVersion,
      mode: 'empty',
      reason: 'no_nearby_stores',
      candidates: [],
      preferred: null,
      alternative: null,
      banner: { trigger: false },
    };
    _cachePut(key, empty);
    return { ...empty, cache_hit: false };
  }

  if (items.length === 0) {
    const empty = {
      list_id: listId,
      list_version: listVersion,
      mode: 'empty',
      reason: 'empty_list',
      candidates: stores.map(s => ({
        store_id: s.id, store_name: s.name, store_address: s.address,
        total_cost: 0, missing_count: 0, matched_count: 0, items: [],
      })),
      preferred: null,
      alternative: null,
      banner: { trigger: false },
    };
    _cachePut(key, empty);
    return { ...empty, cache_hit: false };
  }

  // 4. Reference unit prices (for Tier-3 ±30% band)
  const refPrices = await _buildReferenceUnitPrices(items);

  // 5. Price basket per candidate store (parallel)
  const candidates = await Promise.all(
    stores.map(s => priceBasketAtStore({ items, store: s, refPrices }))
  );

  // 6. Drive time enrichment (single batched DM call)
  const driveTimes = await driveTimeService.getDriveTimes({
    userLat, userLng,
    stores: stores.map(s => ({ id: s.id, lat: s.lat, lng: s.lng })),
  });
  for (let i = 0; i < candidates.length; i++) {
    const dt = driveTimes[i];
    candidates[i].drive_minutes = dt ? Math.round(dt.duration_seconds / 60) : null;
    candidates[i].distance_meters = dt ? dt.distance_meters : null;
  }

  // 7. Mode resolution + banner trigger
  const { mode, preferred, alternative } = await _resolveMode({ userId, candidates });
  const banner = evaluateBannerTrigger({ preferred, alternative });

  const value = {
    list_id: listId,
    list_version: listVersion,
    mode,
    candidates,
    preferred,
    alternative,
    banner,
  };
  _cachePut(key, value);
  return { ...value, cache_hit: false };
}

module.exports = {
  getRecommendations,
  getCandidateStores,
  matchItemAtStore,
  priceBasketAtStore,
  evaluateBannerTrigger,
  clearCache,
  // exported for tests / future extension
  _normalizePacs,
  _recencyDecay,
  _substitutionScore,
  CACHE_TTL_MS,
  STALENESS_DAYS,
  PACS_GATE,
  TRIGRAM_THRESHOLD,
  PRICE_BAND_FACTOR,
};
