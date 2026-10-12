#!/bin/zsh
# Backfill Report 16 (detention) and Report 19 (punctuality) into the local
# store, then publish to the shared Google Sheet.
#
# Double-click it. It works for a bounded stretch, then stops and prints what
# is left, so the load on ICMS stays something a person is watching rather
# than an unattended crawl. Run it again to continue; nothing already
# captured is re-fetched.
#
# Before the first run: sign in to ICMS in the collector's browser
#   node collector/icms-collector.mjs setup
#
# Knobs:
#   DAYS=365        how far back to go
#   MINUTES=15      how long this run may spend
#   BATCH=40        requests per pass

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

DAYS="${DAYS:-365}"
MINUTES="${MINUTES:-15}"
BATCH="${BATCH:-40}"
DEADLINE=$(( $(date +%s) + MINUTES * 60 ))

run_report() {
  local report="$1"
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    local out
    out="$(/usr/bin/env node collector/icms-collector.mjs backfill "$report" "$DAYS" "" "$BATCH" | tail -1)"
    local left stopped
    left="$(printf '%s' "$out" | /usr/bin/python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read()).get("remaining", "?"))
except Exception: print("?")')"
    stopped="$(printf '%s' "$out" | /usr/bin/python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read()).get("stopped") or "")
except Exception: print("")')"
    echo "  $report: $left still to collect"
    if [ -n "$stopped" ]; then echo "  $stopped"; return 1; fi
    if [ "$left" = "0" ]; then return 0; fi
    if [ "$left" = "?" ]; then echo "  $report: unexpected output"; echo "$out" | tail -3; return 1; fi
  done
  echo "  $report: time budget reached, run this again to continue"
  return 0
}

echo "Detention (Report 16), weekly windows"
run_report pam16
echo
echo "Punctuality (Report 19), one request per date"
run_report pam19
echo
echo "Ingesting and publishing"
/usr/bin/python3 -m icms.publish

echo
echo "Done for this run. Double-click again to continue if anything is left."
read -k 1 -s
