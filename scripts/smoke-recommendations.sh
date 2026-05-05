#!/usr/bin/env bash
# scripts/smoke-recommendations.sh
# ============================================================
# Three-phase smoke test for /api/recommendations/where-to-shop.
# Validates the live endpoint against real production state in a way
# that mock-based unit tests cannot.
#
# Phases (matching the spec from 2026-05-05):
#   (i)   No consent yet         → expect "user_not_opted_in"
#   (ii)  Consent + no allergens → expect engine runs (mode A/B/C/empty)
#   (iii) Consent + allergens    → expect "allergen_safety_unavailable"
#
# Required env:
#   SMART_CART_TOKEN     bearer JWT for the test user
#   USER_ID              UUID of the test user (must match the JWT)
#   LIST_ID              UUID of a list owned by USER_ID
#   LAT, LNG             coordinates for the curl (default: 40.7128,-74.0060)
#
# Optional env:
#   SMART_CART_API_URL   default: https://smart-cart-api.onrender.com
#   DATABASE_URL         if set, the script auto-runs the UPDATE
#                        statements between phases. If unset, the
#                        script prints the SQL and pauses for you to
#                        run it in another terminal (Render psql shell).
#
# Side effects: this script MUTATES user_settings for USER_ID across
# phases. It restores the pre-test state at the end IF it captured it.
# If you Ctrl-C mid-script, the user is left in the last-set state —
# run with PHASE=reset to put recommend_stores_enabled=NULL and
# allergens='{}' back to defaults.
#
# Dependencies: curl, jq, optionally psql.
# ============================================================

set -euo pipefail

API_URL="${SMART_CART_API_URL:-https://smart-cart-api.onrender.com}"
LAT="${LAT:-40.7128}"
LNG="${LNG:--74.0060}"

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "ERROR: \$$name is required" >&2
    exit 1
  fi
}

require SMART_CART_TOKEN
require USER_ID
require LIST_ID

run_sql() {
  local sql="$1"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    echo "[sql] $sql"
    psql "$DATABASE_URL" -c "$sql" -q
  else
    echo
    echo "[manual] Run this in your psql shell, then press Enter:"
    echo "  $sql"
    echo
    read -r -p "Press Enter when done..." _
  fi
}

curl_endpoint() {
  curl -sS -w '\n[http_status: %{http_code}]\n' \
    -H "Authorization: Bearer $SMART_CART_TOKEN" \
    "$API_URL/api/recommendations/where-to-shop?list_id=$LIST_ID&lat=$LAT&lng=$LNG"
}

assert_reason() {
  local body="$1"
  local expected="$2"
  local label="$3"
  local actual
  actual=$(echo "$body" | sed -n '1,/\[http_status/p' | head -n -1 | jq -r '.reason // empty')
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS — reason=$actual"
  else
    echo "  FAIL — expected reason=$expected, got reason=$actual"
    echo "  Full body:"
    echo "$body" | sed 's/^/    /'
    exit 2
  fi
}

assert_engine_ran() {
  local body="$1"
  local enabled blocked mode
  enabled=$(echo "$body" | sed -n '1,/\[http_status/p' | head -n -1 | jq -r '.enabled')
  blocked=$(echo "$body" | sed -n '1,/\[http_status/p' | head -n -1 | jq -r '.blocked')
  mode=$(echo   "$body" | sed -n '1,/\[http_status/p' | head -n -1 | jq -r '.mode')
  if [[ "$enabled" == "true" && "$blocked" == "false" && -n "$mode" ]]; then
    echo "  PASS — enabled=true blocked=false mode=$mode"
  else
    echo "  FAIL — enabled=$enabled blocked=$blocked mode=$mode"
    echo "  Full body:"
    echo "$body" | sed 's/^/    /'
    exit 2
  fi
}

restore_state() {
  echo
  echo "=== RESTORE: clearing test state ==="
  run_sql "UPDATE user_settings SET recommend_stores_enabled = NULL, allergens = '{}' WHERE user_id = '$USER_ID';"
}
trap restore_state EXIT

# ── Phase: reset only ──────────────────────────────────────
if [[ "${PHASE:-}" == "reset" ]]; then
  echo "PHASE=reset — clearing user state and exiting."
  trap - EXIT
  restore_state
  exit 0
fi

# ── Phase (i): no consent ──────────────────────────────────
echo
echo "=== Phase (i) — No consent (column IS NULL, allergens empty) ==="
run_sql "UPDATE user_settings SET recommend_stores_enabled = NULL, allergens = '{}' WHERE user_id = '$USER_ID';"
body=$(curl_endpoint)
echo "$body"
assert_reason "$body" "user_not_opted_in" "consent gate"

# ── Phase (ii): consent given ──────────────────────────────
echo
echo "=== Phase (ii) — Consent + no allergens (engine should run) ==="
run_sql "UPDATE user_settings SET recommend_stores_enabled = TRUE WHERE user_id = '$USER_ID';"
body=$(curl_endpoint)
echo "$body"
assert_engine_ran "$body"

# ── Phase (iii): allergen present ──────────────────────────
echo
echo "=== Phase (iii) — Consent + allergens (allergen gate fires) ==="
run_sql "UPDATE user_settings SET allergens = '{dairy}' WHERE user_id = '$USER_ID';"
body=$(curl_endpoint)
echo "$body"
assert_reason "$body" "allergen_safety_unavailable" "allergen gate"

echo
echo "=== ALL THREE PHASES PASSED ==="
