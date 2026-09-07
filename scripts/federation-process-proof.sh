#!/usr/bin/env sh
set -eu

cleanup() {
  docker compose -p veridex-federation-proof -f docker-compose.federation.yml down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker compose -p veridex-federation-proof -f docker-compose.federation.yml up -d --wait federation-postgres
npm --prefix bazaar-service run build
node scripts/federation-process-proof.mjs