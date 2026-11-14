#!/usr/bin/env bash
# Timer job: deploy the head of main once all of its CI check runs are green.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/trafficsim}
REPO=${REPO:-cpfaffinger/TrafficSim}
STATE_DIR="$APP_DIR/.deploy"
cd "$APP_DIR"
mkdir -p "$STATE_DIR"

head=$(git ls-remote origin refs/heads/main | cut -f1)
[ -n "$head" ] || { echo "cannot resolve origin/main" >&2; exit 1; }
[ "$head" = "$(cat "$STATE_DIR/deployed" 2>/dev/null || true)" ] && exit 0
[ "$head" = "$(cat "$STATE_DIR/failed" 2>/dev/null || true)" ] && exit 0

verdict=$(curl -fsS -H "Accept: application/vnd.github+json" -H "User-Agent: trafficsim-cd" \
  "https://api.github.com/repos/${REPO}/commits/${head}/check-runs?per_page=100" | python3 -c '
import json, sys
runs = json.load(sys.stdin).get("check_runs", [])
if not runs:
    print("none")
elif any(r["status"] != "completed" for r in runs):
    print("pending")
elif all(r["conclusion"] in ("success", "skipped", "neutral") for r in runs):
    print("green")
else:
    print("red")
')

case "$verdict" in
  green) exec "$APP_DIR/deploy/staging/deploy.sh" "$head" ;;
  red) echo "CI failed for $head, not deploying"; echo "$head" > "$STATE_DIR/failed" ;;
  *) echo "CI $verdict for $head" ;;
esac
