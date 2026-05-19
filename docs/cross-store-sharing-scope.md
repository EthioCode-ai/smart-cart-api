# Cross-store price/availability sharing scope (market ∩ format)

Design note. Author: claude-code, 2026-05-19. Status: draft, open questions for Avi. **Separate track from Phase 0 scanner work — do not conflate.**

## The rule (Avi, 2026-05-19)

A product/price scanned at Store A is shared for availability + price comparison at Store B **only if** A and B are:
- in the **same market** (the existing ~50-mile zone), AND
- the **same chain + format** (e.g., Walmart Neighborhood Market ≠ Walmart Supercenter ≠ Target).

Working assumption: same-format same-chain stores in a market carry the same catalog. Known exception: some SKUs are store-specific. Mitigation: **learn from observed data and trim** products from stores where they're not actually seen.

## Current state (verified 2026-05-19, not assumed)

- **No chain/format/banner field exists** on `stores` (schema grep: nothing). Store identity = name + address + lat/lng.
- `marketPriceWriter` shares prices by **zone only** (`ZONE_RADIUS_KM = 80.5`, Haversine on `anchor_*`). **Zero format discrimination.**
- `recommendationService` (where-to-shop) reads the same zone-shared prices → currently *can* compare a Supercenter price as if valid at a Neighborhood Market.

**This is an existing correctness gap, not just missing future work.** The current model is *too permissive* vs. the intended rule.

## Severity

Real, but **not acute now**: at N=1 launch + sparse data + Avi solo-seeding known stores, it won't bite. It becomes a genuine data-integrity problem as crowdsourced data grows across mixed-format stores in one metro. **Must be designed before broad crowdsourced rollout**; not an emergency for launch/seed.

## What it requires (none exists yet)

1. **Structured `chain` + `format` on `stores`.** Initial source: parse the Google Places name the `/api/stores/register` flow already receives ("Walmart Supercenter" / "Walmart Neighborhood Market"). Must be a real field + a classification step + a correction path — not an ad-hoc string match at read time.
2. **Scope the share/read path by `zone ∩ (chain,format)`** — changes to `marketPriceWriter` (write/lookup zone query) AND `recommendationService` (candidate comparison). Both currently zone-only.
3. **Per-store availability + trim mechanism.** Track observed presence per (store, product); prune the assumed-shared catalog when data shows absence. New capability — needs a presence signal + a decay/threshold rule.

## Open questions for Avi (before any code)

1. **Format taxonomy & source of truth:** parse from Places name (cheap, fuzzy) vs. a maintained chain/format table vs. manual tag at store registration? What's the canonical list of formats per chain?
2. **"Same market" definition:** reuse the existing 50-mile anchor zone, or a different boundary for catalog-sharing vs. price-corroboration?
3. **Trim algorithm:** what signal = "not sold here" (N scans of the store without seeing it? a receipt without it? explicit absence?), and what threshold/decay before trimming? False-trim risk (seasonal/out-of-stock ≠ not-carried).
4. **Migration scope:** add `chain`/`format` to `stores` + backfill existing rows (how — Places re-lookup? name parse?). Interaction with the existing market_prices anchor model.
5. **Sequencing:** before or after N=2 flip (`docs/n1-to-n2-redesign.md`)? They both reshape the moat read path; doing them together vs. separately.

## Not in scope here

Phase 0 scanner instrumentation (WalkScan recorder, B1) is unaffected and proceeds independently. This note is the moat data-model track only.
