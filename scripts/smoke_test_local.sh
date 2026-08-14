#!/usr/bin/env bash
set -euo pipefail
BASE_URL=${FACILITATOR_URL:-http://localhost:3002}

echo "Checking facilitator health..."
curl -sS ${BASE_URL}/health | jq .

echo "Checking supported schemes..."
curl -sS ${BASE_URL}/supported | jq .

echo "Checking canonical /verify request validation (expects HTTP 400)"
status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/verify" \
  -H 'Content-Type: application/json' -d '{}')
test "$status" = "400"
