#!/usr/bin/env bash
# Builds and rolls out one commit of TrafficSim on this host (default: origin/main).
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/trafficsim}
STATE_DIR="$APP_DIR/.deploy"
cd "$APP_DIR"
mkdir -p "$STATE_DIR"

exec 9>"$STATE_DIR/lock"
if ! flock -n 9; then
  echo "another deployment is running"
  exit 0
fi

git fetch --quiet origin main
target=$(git rev-parse "${1:-origin/main}")
trap 'echo "$target" > "$STATE_DIR/failed"; echo "deployment of $target FAILED" >&2' ERR

echo "deploying $target"
git checkout --quiet --detach "$target"

# Re-read the env after checkout; build metadata is injected per deployment.
set -a
# shellcheck disable=SC1091
. ./.env
set +a
export SOURCE_COMMIT="${target:0:12}"
export TRAFFICSIM_IMAGE_TAG="${target:0:12}"

mkdir -p data/postgres data/cache data/osm
chown 1654:1654 data/cache data/osm # APP_UID of the .NET runtime image

DOCKER_BUILDKIT=1 docker compose build app
docker compose up -d --remove-orphans

port="${TRAFFICSIM_HTTP_PORT:-8080}"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${port}/readyz" >/dev/null 2>&1; then
    echo "$target" > "$STATE_DIR/deployed"
    rm -f "$STATE_DIR/failed"
    docker image prune -f --filter "label=org.opencontainers.image.source=https://github.com/cpfaffinger/TrafficSim" >/dev/null || true
    echo "deployed $target (ready)"
    exit 0
  fi
  sleep 2
done

echo "app did not become ready" >&2
false
