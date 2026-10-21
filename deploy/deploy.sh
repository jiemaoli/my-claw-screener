#!/bin/sh
set -eu

APP_DIR=/root/apps/claw-screener
ARCHIVE=/root/apps/claw_screener_deploy.tar.gz

mkdir -p "$APP_DIR/data"
test -f "$APP_DIR/.env"
test -f "$ARCHIVE"

tar -xzf "$ARCHIVE" -C "$APP_DIR" --exclude=.env --exclude=data
rm -rf "$APP_DIR/.git"
rm -f "$APP_DIR/deploy/claw-screener.cron"

cd "$APP_DIR/deploy"
docker compose up -d --build

cp "$APP_DIR/deploy/nginx-stock-claw.conf" /root/infrastructure/nginx/conf.d/stock-claw.conf
docker exec nginx-proxy nginx -t
docker exec nginx-proxy nginx -s reload

rm -f "$ARCHIVE"
docker compose ps
