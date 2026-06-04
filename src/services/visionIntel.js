// src/services/visionIntel.js
// ============================================================
// VEPI (Vision-Enhanced Product Intelligence) - v1
//
// Three responsibilities:
//   1. extractProductIntel(name, brand, imageUrl)
//        - sends product photo + label text to GPT-4o-mini with vision
//        - returns structured JSON: product_type, subtype, is_a, is_not,
//          form, key_descriptors, confidence
//        - used by the background worker on each unprocessed product
//   2. extractSearchIntel(query)
//        - text-only LLM parse of a user's search string into the same
//          shape (less the metadata). e.g. "parmesan cheese" ->
//          { search_type: "cheese", search_subtype: "parmesan", ... }
//        - cached in-memory (Map) so repeat queries are free
//        - used by brand-options endpoint on each search
//   3. scoreProductForSearch(productIntel, searchIntel)
//        - returns a numerical score for ranking
//        - HARD EXCLUDE (-Infinity) if search_type appears in
//          product_intel.is_not - this is the "Red Baron Cheese Pizza
//          excluded from cheese search" guarantee
//
// This module is PURE - no DB. The worker reads/writes the DB; this
// module just thinks about products and queries.
// ============================================================

let openai = null;
try {
  const OpenAI = require('openai');
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
} catch (err) {
  console.warn('VEPI: OpenAI not available, vision extraction disabled');
}

// ── Prompts ─────────────────────────────────────────────────
const PRODUCT_INTEL_SYSTEM_PROMPT = `You are a grocery product analyzer. You will see a product image and its text label. Return a JSON object describing what the product IS and IS NOT.

Fields (all required):
- product_type: the primary category, lowercase ("cheese", "pizza", "cereal", "pasta sauce", "yogurt", "ice cream", "potato chips", "soft drink", etc.)
- product_subtype: a more specific descriptor, lowercase ("parmesan", "frozen", "marinara", "greek", "vanilla")
- form: how the product is packaged ("wedge", "shredded", "frozen", "carton", "box", "bag", "bottle", "jar")
- key_descriptors: array of 3-5 lowercase key descriptors visible on the package or implied by it
- is_a: array of lowercase categories this product IS. Include the type and meaningful broader categories. e.g. for parmesan: ["cheese", "parmesan", "italian cheese", "hard cheese"]
- is_not: array of lowercase categories this product IS NOT despite words in its name. Be aggressive here. e.g. "Red Baron Cheese Pizza" has is_not: ["cheese", "yogurt"]. "Chicken & Cheese Flautas" has is_not: ["cheese"]. "Cottage Cheese" does NOT include "cheese" in is_not (it really is cheese).
- confidence: 0.0 to 1.0 how confident you are. Lower for blurry/partial images.

Return ONLY valid JSON. No prose, no markdown fences.`;

const SEARCH_INTEL_SYSTEM_PROMPT = `You are a grocery search analyzer. The user has typed a product name they're looking for. Return a JSON object describing what they want.

Fields (all required):
- search_type: the primary product category they want, lowercase ("cheese", "pasta sauce", "pizza", "cereal")
- search_subtype: more specific descriptor or null ("parmesan", "frozen", "marinara")
- key_descriptors: array of lowercase descriptors
- is_a: array of broader categories the wanted product is. e.g. for "parmesan cheese": ["cheese", "parmesan", "italian cheese"]
- is_not: usually empty array; only fill if the query explicitly excludes something

Return ONLY valid JSON. No prose, no markdown fences.`;

// ── Helpers ─────────────────────────────────────────────────
const parseJsonStrict = (text) => {
  if (!text || typeof text !== 'string') return null;
  // Strip markdown fences if the model added them despite instructions
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
};

const normalizeProductIntel = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const arr = (v) => Array.isArray(v) ? v.map(s => String(s).toLowerCase().trim()).filter(Boolean) : [];
  const str = (v) => v == null ? null : String(v).toLowerCase().trim();
  const numConf = typeof raw.confidence === 'number'
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0.5;
  return {
    product_type:    str(raw.product_type) || 'unknown',
    product_subtype: str(raw.product_subtype),
    form:            str(raw.form),
    key_descriptors: arr(raw.key_descriptors),
    is_a:            arr(raw.is_a),
    is_not:          arr(raw.is_not),
    confidence:      numConf,
  };
};

const normalizeSearchIntel = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const arr = (v) => Array.isArray(v) ? v.map(s => String(s).toLowerCase().trim()).filter(Boolean) : [];
  const str = (v) => v == null ? null : String(v).toLowerCase().trim();
  return {
    search_type:     str(raw.search_type) || 'unknown',
    search_subtype:  str(raw.search_subtype),
    key_descriptors: arr(raw.key_descriptors),
    is_a:            arr(raw.is_a),
    is_not:          arr(raw.is_not),
  };
};

// ── 1. Extract product intel from photo + label ─────────────
const extractProductIntel = async (name, brand, imageUrl) => {
  if (!openai) return null;
  if (!imageUrl) return null;
  const label = brand ? `${brand} ${name}` : name;
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: PRODUCT_INTEL_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Product label: ${label}` },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
          ],
        },
      ],
      max_tokens: 400,
      temperature: 0,
    });
    const raw = completion.choices[0]?.message?.content || '';
    const parsed = parseJsonStrict(raw);
    const intel = normalizeProductIntel(parsed);
    if (!intel) return null;
    intel.vision_processed_at = new Date().toISOString();
    intel.model = 'gpt-4o-mini';
    return intel;
  } catch (err) {
    console.error(`VEPI extract error for "${label}":`, err.message);
    return null;
  }
};

// ── 2. Extract search intel (text-only, cached) ─────────────
const SEARCH_INTEL_CACHE = new Map();
const SEARCH_INTEL_CACHE_MAX = 2000;

const extractSearchIntel = async (queryText) => {
  if (!openai) return null;
  const key = String(queryText || '').toLowerCase().trim();
  if (!key) return null;
  if (SEARCH_INTEL_CACHE.has(key)) {
    return SEARCH_INTEL_CACHE.get(key);
  }
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SEARCH_INTEL_SYSTEM_PROMPT },
        { role: 'user', content: key },
      ],
      max_tokens: 200,
      temperature: 0,
    });
    const raw = completion.choices[0]?.message?.content || '';
    const parsed = parseJsonStrict(raw);
    const intel = normalizeSearchIntel(parsed);
    if (!intel) return null;
    if (SEARCH_INTEL_CACHE.size >= SEARCH_INTEL_CACHE_MAX) {
      // Simple FIFO eviction: drop the oldest entry
      const firstKey = SEARCH_INTEL_CACHE.keys().next().value;
      SEARCH_INTEL_CACHE.delete(firstKey);
    }
    SEARCH_INTEL_CACHE.set(key, intel);
    return intel;
  } catch (err) {
    console.error(`VEPI search intel error for "${key}":`, err.message);
    return null;
  }
};

// ── 3. Score a product against a search ─────────────────────
const HARD_EXCLUDE = -Infinity;

const scoreProductForSearch = (productIntel, searchIntel) => {
  if (!productIntel || !searchIntel) return 0;

  // HARD EXCLUDE: search_type appears in product's is_not
  // (the Red Baron Cheese Pizza exclusion from cheese search)
  const sType = searchIntel.search_type;
  if (sType && Array.isArray(productIntel.is_not) && productIntel.is_not.includes(sType)) {
    return HARD_EXCLUDE;
  }
  // ALSO hard-exclude if any of the searcher's is_a appears in product's is_not
  // (more aggressive: "I want italian cheese" excludes anything is_not italian cheese)
  if (Array.isArray(searchIntel.is_a)) {
    for (const tag of searchIntel.is_a) {
      if (productIntel.is_not && productIntel.is_not.includes(tag)) {
        return HARD_EXCLUDE;
      }
    }
  }

  let score = 0;

  // Direct type match
  if (sType && productIntel.product_type === sType) score += 100;

  // search_type appears in product's is_a (broader match)
  if (sType && Array.isArray(productIntel.is_a) && productIntel.is_a.includes(sType)) {
    score += 80;
  }
  // product_type appears in searcher's is_a (also broader)
  if (productIntel.product_type && Array.isArray(searchIntel.is_a)
      && searchIntel.is_a.includes(productIntel.product_type)) {
    score += 80;
  }

  // Subtype match
  if (searchIntel.search_subtype
      && productIntel.product_subtype === searchIntel.search_subtype) {
    score += 50;
  }

  // Descriptor overlap
  if (Array.isArray(searchIntel.key_descriptors) && Array.isArray(productIntel.key_descriptors)) {
    const productDescSet = new Set(productIntel.key_descriptors);
    for (const d of searchIntel.key_descriptors) {
      if (productDescSet.has(d)) score += 10;
    }
  }

  // is_a overlap (additional positive evidence)
  if (Array.isArray(searchIntel.is_a) && Array.isArray(productIntel.is_a)) {
    const productIsASet = new Set(productIntel.is_a);
    let overlapCount = 0;
    for (const tag of searchIntel.is_a) {
      if (productIsASet.has(tag) && tag !== sType) overlapCount += 1;
    }
    score += overlapCount * 20;
  }

  // Confidence multiplier - softly penalize low-confidence fingerprints
  if (typeof productIntel.confidence === 'number') {
    score *= (0.5 + 0.5 * productIntel.confidence);
  }

  return score;
};

// ── Test helpers ────────────────────────────────────────────
const _resetSearchIntelCache = () => SEARCH_INTEL_CACHE.clear();

module.exports = {
  extractProductIntel,
  extractSearchIntel,
  scoreProductForSearch,
  normalizeProductIntel,
  normalizeSearchIntel,
  parseJsonStrict,
  HARD_EXCLUDE,
  _resetSearchIntelCache,
};
