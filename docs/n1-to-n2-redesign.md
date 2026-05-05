# N=1 → N=2 redesign

Memo for the post-launch flip of `priceValidator.DEFAULTS.minCorroboratingScans` from `1` to `2`. Author: claude-code, 2026-05-05. Status: design draft pending Avi review.

## TL;DR

The flip itself is a one-line change. The substantive question is **what risks the flip exposes that the launch-mode bypass had been hiding**, and **what we want to fix before vs. after**. Three findings, two recommendations, four tests to add. Plus one operational item that goes live the day we flip.

---

## Current state (N = 1, launch mode)

`priceValidator.validatePriceWrite` runs three gates. Today the third is bypassed.

```
1. Bounds check       → reject if price outside [0.10, 500.00]
2. Confidence gate    → camera sources < 0.70 conf → quarantine 'low_confidence'
3. Delta gate         → BYPASSED today (gated behind minCorroboratingScans >= 2)
```

In practice the moat accepts every well-formed scan. The pending table accumulates only `low_confidence` quarantines from camera sources. The corroboration partner-finding logic (`findPendingPartner`) is dead code at N=1.

This is intentional — quarantining everything during cold-start would block the database from ever reaching critical mass.

## Target state (N = 2, post-launch)

The delta gate activates. Concretely:

```
3. Delta gate (active)
   IF an existing market_prices zone exists for this barcode AND
      |new_price - existing_price| / existing_price > 0.50
   THEN quarantine reason='awaiting_corroboration', insert into pending.

   Subsequent matching scan finds the pending partner via findPendingPartner:
     same barcode, ±5% price tolerance, within 24h, different scanner
     → DELETE pending row, UPDATE market_prices with the new price
     → market_prices_history records 'promoted_from_pending'
```

What does NOT change:
- First scan of a brand-new barcode → still accepted directly (no existing zone to compare against).
- Bounds check unchanged.
- Confidence gate unchanged.
- Existing market_prices rows promoted under N=1 stay promoted (per-the-existing comment in `marketPriceWriter.js:18-21`, no re-validation pass).

---

## Three findings worth deciding on before the flip

### Finding 1: The first-scan-of-new-barcode asymmetry

The delta gate only fires when an existing zone is present. New barcodes always accept their first scan directly — there's no other reasonable choice short of an absolute price oracle. But this leaves an asymmetric failure mode:

| Sequence | Outcome under N=2 |
|---|---|
| Adversary scans $50 first, second scanner scans $5 | $50 stays in market_prices. Second scan quarantined (delta=0.9). Third matching $5 scan promotes the pending → market_prices = $5. |
| Honest first scan $5, adversary scans $50 second | $5 stays. $50 quarantined. Adversary needs a partner to corroborate, which they can't get if no other adversary is in range. |

**The asymmetry: adversary-first is harder to displace than honest-first.** Two corroborating scans needed to overturn an adversary's first-scan; adversary needs two corroborating scans to overturn an honest first-scan. Symmetric in cost — but the existing wrong price stays "the truth" during the corroboration window.

**Mitigations available:**
- (a) Accept this as a known limitation. Document it.
- (b) **Trusted-source bypass:** receipts (when v1.1 ships), admin-tagged power scanners, or aisle-tagged scans get a higher trust weight that displaces single adversarial first-scans without waiting for two corroborators.
- (c) **Symmetric quarantine:** under N=2, ALSO quarantine first-scan-of-new-barcode (requires a partner before any zone gets created). Slow ramp but no asymmetry.

(c) is the purist N=2 but blocks every brand-new barcode entry until two scanners overlap — punishing for niche items. **Recommend (a) at flip time + (b) when we ship receipts in v1.1.**

### Finding 2: The single-power-scanner deadlock

`findPendingPartner` requires `scanned_by != $4::uuid` (or NULL). This is correct for adversarial-corroboration prevention but creates a deadlock when only one power user is scanning — Avi's two scans of the same item can never corroborate themselves under N=2.

There's already a TODO in `marketPriceWriter.js:145-149` flagging this:

> Add a `trusted_users` whitelist (admins / power scanners) who bypass the different-user requirement. Otherwise a single trusted operator's two scans of the same item can never corroborate themselves, blocking legitimate writes during the early-N=2 window when the user base is small.

**This is load-bearing for the early-N=2 window.** Without it, the day after the flip every borderline scan from Avi gets quarantined and never auto-promotes. Admin endpoint can rescue them, but that's manual work proportional to scan volume.

**Recommend:** ship the trusted_users mechanism in the same commit as the flip (or one commit before), not as a follow-up. Smallest viable shape:

```sql
-- migration
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_trusted_scanner BOOLEAN NOT NULL DEFAULT false;
```

```js
// findPendingPartner: if either side is_trusted_scanner, skip the
// different-user requirement.
//   AND (
//     scanned_by IS NULL
//     OR $4::uuid IS NULL
//     OR scanned_by != $4::uuid
//     OR EXISTS (SELECT 1 FROM users WHERE id = scanned_by AND is_trusted_scanner)
//     OR EXISTS (SELECT 1 FROM users WHERE id = $4::uuid AND is_trusted_scanner)
//   )
```

The trusted bit is opt-in and admin-set. Single user scanning. Adversarial trust escalation requires DB write access. Cheap to ship, removes the deadlock.

### Finding 3: The 0.50 delta threshold may be too lax

`quarantineDeltaThreshold = 0.50` was set when N=1 meant "this number doesn't matter." At N=2 it becomes the actual moat. 50% means $5 → $7.50 (a 50% price hike) goes straight through with zero corroboration if no zone existed before.

In real grocery data, sustained 30–50% price moves are rare without sale tags. **A 0.30 (30%) threshold catches more drift while still allowing legitimate inflation/sales to flow.**

But: tightening also means MORE pending rows during early-N=2. Higher admin review burden. And the trusted_users mechanism (Finding 2) becomes more important as more rows quarantine.

**Recommend:** flip first with 0.50 unchanged. Watch pending volume for two weeks. Tighten to 0.30 in a follow-up if pending is healthy (low backlog). This is reversible — `priceValidator.DEFAULTS` is a single constant. No schema implication.

---

## Recommended rollout sequence

This sequence preserves the "SQL → backend → frontend" deploy order and keeps each step independently rollback-able.

```
Step 1.  Trusted-scanner schema migration + writer code change
         New file: src/db/migrations/2026_05_phase2_trusted_scanner.sql
         Edit:     src/services/marketPriceWriter.js (findPendingPartner WHERE clause)
         Test:     src/services/marketPriceWriter.test.js (if exists) — partner check
                   honors is_trusted_scanner on either side

Step 2.  Admin-set trusted bit on Avi's user row
         psql:     UPDATE users SET is_trusted_scanner = true WHERE id = 'avi-uuid';

Step 3.  Two-week observation window at N=1
         Confirm: zero regressions from Step 1 (the WHERE clause change applies
         even at N=1, but is dormant since the delta gate doesn't fire).
         Confirm: scripts/review-pending.sh works against current pending volume.

Step 4.  Flip the constant
         priceValidator.DEFAULTS.minCorroboratingScans: 1 → 2
         Add tests (see below) before the commit.

Step 5.  One-week monitoring
         Watch:
           - SELECT count(*) FROM market_prices_pending
                WHERE quarantine_reason = 'awaiting_corroboration';
             — should grow then stabilize as partners come in
           - SELECT count(*) FROM market_prices_pending
                WHERE created_at < NOW() - INTERVAL '24 hours';
             — should stay near zero (older pending = stuck rows needing
               admin review or dropping by review-pending.sh reject)
           - market_prices_history event_type='promoted_from_pending'
             count per day — measures the corroboration engine's actual work

Step 6.  (Optional, deferred) Tighten delta threshold to 0.30 if pending volume
         stays healthy. One-line change to DEFAULTS, redeploy.
```

## Tests to add before the flip (Step 4)

Pure-validator tests against `validatePriceWrite` in `priceValidator.test.js`:

```
H. With minCorroboratingScans=2 + existing + delta > 0.5 → quarantine
   reason='awaiting_corroboration'
I. With minCorroboratingScans=2 + existing + delta exactly at 0.5 → accept
   (boundary: > not >=)
J. With minCorroboratingScans=2 + NO existing → accept (first scan exception)
K. With minCorroboratingScans=2 + existing + delta < 0.5 → accept
```

Integration tests against `writeMarketPrice` (mock pool):

```
L. N=2 quarantine cycle: scan-1 (existing $5, new $50) → pending.
   scan-2 ($50 ± 5%, different user, within 24h) → finds partner → promotes,
   market_prices.price = $50, history records both 'promoted_from_pending'
   and the original 'insert' if there was one.
M. N=2 deadlock without trusted bit: same user, two scans, no partner found,
   both pending. Resolved by either admin override or another user.
N. N=2 with is_trusted_scanner=true on either side: same-user scans CAN
   corroborate, partner found, promotion happens.
O. N=2 fluke isolation: confidence still gates first. Low-conf scan still
   goes to pending with reason='low_confidence' regardless of N.
```

These four pure-validator tests would land alongside the flip commit. The four integration tests should land alongside the trusted-scanner commit (Step 1) since they exercise its WHERE-clause changes.

## Operational additions for the flip day

These don't need new code — they need explicit declared SOP:

1. **Pending review cadence.** With N=2, `market_prices_pending.awaiting_corroboration` rows accumulate. `scripts/review-pending.sh list awaiting_corroboration` shows the queue. Need a rhythm — daily for the first week, then weekly.
2. **Stale pending alert.** Rows older than `corroborationFreshnessHours` (24h) can no longer auto-promote. They sit in pending forever unless admin reviews. **Recommend a daily cron** (similar shape to `driveTimeService.startCleanupCron`) that surfaces stale pending counts, but DOES NOT auto-purge — these are user contributions, not cache rows.
3. **Rollback plan.** If pending volume blows up post-flip, rollback is a one-line revert (`minCorroboratingScans: 1`) + redeploy. Existing pending rows survive; they'll just stop being created. Admin can promote or reject the backlog at leisure.

## What NOT to do

Worth being explicit about a few non-changes that someone might mistakenly bundle with the flip:

- **Do NOT re-validate historical market_prices rows.** Per the existing comment, rows promoted under N=1 stay promoted. Re-validating retroactively would mean potentially demoting rows that have since accumulated trust signals (scan_count, confidence_avg) — destroying real history.
- **Do NOT lower the freshness window from 24h.** The window is the user-pair time budget for corroboration. Tighter = more frequent failures. Looser is the safer direction if anything.
- **Do NOT change the 5% price tolerance for partner matching.** That's the "are these two scans plausibly the same observation?" gate, not a moat threshold. Different concern.

## Open questions for Avi

1. **Trusted-scanner mechanism: agree with Finding 2's recommendation to ship before the flip?** If so, want me to spec the migration + code change as commit 13/14 (or whatever number, post-allergen-overrides)?
2. **Delta threshold: keep at 0.50 for the flip, tighten later?** Or tighten in the same commit?
3. **Stale-pending cron: build now, build alongside the flip, or build only if observed need?**
4. **Rollout calendar: how long after launch before we flip?** The memory entry says "post-launch" but we may want a more concrete trigger — e.g., user count threshold, time threshold, or volume of accepted scans threshold.
