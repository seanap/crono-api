#!/usr/bin/env sh
set -eu

CRONO_ENV_FILE="${CRONO_ENV_FILE:-/app/config/.env}"

if [ -f "$CRONO_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CRONO_ENV_FILE"
  set +a
fi

if [ ! -f /app/runtime/package.json ]; then
  mkdir -p /app/runtime
  cat >/app/runtime/package.json <<'JSON'
{
  "name": "crono-runtime",
  "private": true,
  "version": "0.0.0"
}
JSON
fi

echo '{"message":"installing latest @milldr/crono"}'
npm install --prefix /app/runtime --omit=dev --no-audit --no-fund @milldr/crono@latest

echo '{"message":"syncing credentials"}'
node /app/scripts/sync-credentials.mjs

echo '{"message":"starting api server"}'
exec node /app/src/server.js
