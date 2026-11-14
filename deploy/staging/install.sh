#!/usr/bin/env bash
# One-time bootstrap of TrafficSim staging on a Debian host with Docker + host nginx.
# Idempotent: safe to re-run after changing units or the vhost.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/trafficsim}
REPO_URL=${REPO_URL:-https://github.com/cpfaffinger/TrafficSim.git}
HTTP_PORT=${HTTP_PORT:-28100}
VHOST=stagecompose00.pulseone.dev

if [ ! -d "$APP_DIR/.git" ]; then
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
git fetch --quiet origin main
git checkout --quiet --detach origin/main

mkdir -p .deploy data/postgres data/cache data/osm
if [ ! -f .env ]; then
  password=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
  sed -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${password}/" \
      -e "s/^TRAFFICSIM_HTTP_PORT=.*/TRAFFICSIM_HTTP_PORT=${HTTP_PORT}/" \
      .env.example > .env
  chmod 600 .env
  echo "created $APP_DIR/.env"
fi

install -m 0644 deploy/staging/trafficsim.service /etc/systemd/system/trafficsim.service
install -m 0644 deploy/staging/trafficsim-cd.service /etc/systemd/system/trafficsim-cd.service
install -m 0644 deploy/staging/trafficsim-cd.timer /etc/systemd/system/trafficsim-cd.timer
systemctl daemon-reload
systemctl enable trafficsim.service trafficsim-cd.timer

install -m 0644 "deploy/staging/nginx/${VHOST}.conf" "/etc/nginx/sites-available/${VHOST}.conf"
ln -sf "/etc/nginx/sites-available/${VHOST}.conf" "/etc/nginx/sites-enabled/${VHOST}.conf"
nginx -t
systemctl reload nginx

echo "installed; first deployment: $APP_DIR/deploy/staging/deploy.sh && systemctl start trafficsim-cd.timer"
