#!/usr/bin/env bash
# scripts/review-pending.sh
# ============================================================
# Admin tool for reviewing market_prices_pending rows.
# Calls the /api/admin/pending-prices endpoints (NOT direct psql)
# so the writer's audit trail and admin_override semantics fire.
#
# Usage:
#   ./scripts/review-pending.sh list [reason]     - show pending rows (optionally filtered)
#   ./scripts/review-pending.sh promote <id>      - approve into market_prices (DESTRUCTIVE direction; y/N confirm)
#   ./scripts/review-pending.sh reject  <id>      - hard-delete from pending (y/N confirm)
#
# Environment:
#   SMART_CART_API_URL   default: https://smart-cart-api.onrender.com
#   SMART_CART_TOKEN     required: bearer JWT for admin auth
#
# Dependencies: curl, jq
#
# Notes:
#   - 'reason' filter values: low_confidence | awaiting_corroboration
#   - Promote bypasses validators (admin_override); apply caution.
#   - The original-scanner point award on promote is NOT YET wired
#     in promotePending (TODO) — only the corroborating scanner has
#     earned during the scan that triggered the pending row.
# ============================================================

set -euo pipefail

API_URL="${SMART_CART_API_URL:-https://smart-cart-api.onrender.com}"
TOKEN="${SMART_CART_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "ERROR: SMART_CART_TOKEN env var is required (bearer JWT)" >&2
  echo "  Hint: log in via your client, copy the accessToken, then" >&2
  echo "  export SMART_CART_TOKEN='eyJhbGc...'" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required. Install: brew install jq | apt install jq" >&2
  exit 1
fi

# ── helpers ───────────────────────────────────────────────
api_get() {
  curl -sS -H "Authorization: Bearer $TOKEN" "$API_URL$1"
}

api_post() {
  curl -sS -X POST -H "Authorization: Bearer $TOKEN" "$API_URL$1"
}

api_delete() {
  curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" "$API_URL$1"
}

# ── commands ──────────────────────────────────────────────

cmd_list() {
  local reason="${1:-}"
  local url="/api/admin/pending-prices?limit=100"
  if [ -n "$reason" ]; then
    url="${url}&reason=${reason}"
  fi

  local response
  response=$(api_get "$url")

  local total
  total=$(echo "$response" | jq -r '.total // 0')

  if [ "$total" -eq 0 ]; then
    echo "No pending rows."
    return
  fi

  echo "$response" | jq -r '
    "Total pending: \(.total)  (showing first \(.rows | length))\n",
    (.rows[] |
      "─────────────────────────────────────────────────────",
      "ID:                  \(.id)",
      "Created:             \(.createdAt)",
      "Barcode:             \(.barcode)",
      "Product:             \(.productName // "(unknown)")  \(.productBrand // "")",
      "Price:               $\(.price)" + (if .unitPrice then "  unit: $\(.unitPrice)" else "" end),
      "Existing zone price: \(if .existingZonePrice != null then "$\(.existingZonePrice)" else "(none)" end)",
      "Confidence:          \(.confidence // "n/a")",
      "Source:              \(.source // "n/a")",
      "Reason:              \(.quarantineReason)",
      "Scanned by:          \(.scannedBy // "(anon)")",
      "Location:            (\(.latitude), \(.longitude))",
      ""
    )
  '
}

cmd_promote() {
  local id="${1:?Pending ID required.  Run: $0 list  to find it.}"

  # Show the row first so the operator sees what they are accepting.
  echo "Looking up pending row $id ..."
  local rows
  rows=$(api_get "/api/admin/pending-prices?limit=500" | jq ".rows[] | select(.id == \"$id\")")

  if [ -z "$rows" ]; then
    echo "ERROR: Pending row $id not found" >&2
    exit 1
  fi

  echo "$rows" | jq .
  echo ""
  echo "PROMOTE will:"
  echo "  - INSERT or UPDATE market_prices for this barcode in the zone"
  echo "  - BYPASS the validator (admin_override; no delta/confidence checks)"
  echo "  - Hard-delete this row from market_prices_pending"
  echo "  - Append market_prices_history audit row"
  echo ""

  read -r -p "Confirm promote? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi

  echo ""
  echo "Promoting..."
  local response
  response=$(api_post "/api/admin/pending-prices/$id/promote")
  echo "$response" | jq .
}

cmd_reject() {
  local id="${1:?Pending ID required.  Run: $0 list  to find it.}"

  echo "Looking up pending row $id ..."
  local rows
  rows=$(api_get "/api/admin/pending-prices?limit=500" | jq ".rows[] | select(.id == \"$id\")")

  if [ -z "$rows" ]; then
    echo "ERROR: Pending row $id not found" >&2
    exit 1
  fi

  echo "$rows" | jq .
  echo ""
  echo "REJECT will:"
  echo "  - Hard-delete this row from market_prices_pending"
  echo "  - NOT update market_prices, NOT award points, NOT write history"
  echo "  - The scanner who submitted this gets nothing"
  echo ""

  read -r -p "Confirm reject? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi

  echo ""
  echo "Rejecting..."
  local response
  response=$(api_delete "/api/admin/pending-prices/$id")
  echo "$response" | jq .
}

# ── dispatch ──────────────────────────────────────────────
case "${1:-help}" in
  list)
    shift
    cmd_list "$@"
    ;;
  promote)
    shift
    cmd_promote "$@"
    ;;
  reject)
    shift
    cmd_reject "$@"
    ;;
  *)
    echo "Usage: $0 {list [reason] | promote <id> | reject <id>}" >&2
    echo "" >&2
    echo "Commands:" >&2
    echo "  list [reason]     show pending rows (reason: low_confidence|awaiting_corroboration)" >&2
    echo "  promote <id>      accept into market_prices (admin_override; y/N confirm)" >&2
    echo "  reject  <id>      hard-delete from pending (y/N confirm)" >&2
    echo "" >&2
    echo "Required env: SMART_CART_TOKEN (bearer JWT)" >&2
    echo "Optional env: SMART_CART_API_URL (default: https://smart-cart-api.onrender.com)" >&2
    exit 1
    ;;
esac
