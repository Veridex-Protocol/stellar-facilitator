#!/usr/bin/env bash
#
# One command, clean clone to settled testnet payment.
#
#   ./demo.sh
#
# Creates and funds testnet accounts if needed, brings the stack up with docker
# compose, then runs the conformance harness: a stock x402 client from public
# npm paying for real on Stellar testnet, with the settlement re-read from
# Horizon afterwards.
#
# License: Apache-2.0
set -euo pipefail

cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1mCannot start:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. preflight ─────────────────────────────────────────────────────────────
# Each check here is a failure someone actually hit. Each costs a second and
# turns a cryptic error into an instruction.

command -v node >/dev/null 2>&1 || die "Node.js is not installed. This demo needs Node 22 or newer."

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 22 ]; then
  die "Node $(node -v) is too old. The @x402 packages require Node >=22, and they fail at runtime rather than at install."
fi

if ! docker info >/dev/null 2>&1; then
  die "The Docker daemon is not reachable. Start Docker Desktop (or 'colima start'), or run the
  services directly instead:
    npm run install:all
    npm run dev:facilitator    (in one shell)
    npm run dev:demo-server    (in another)
    npm run conformance        (in a third)"
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "Neither 'docker compose' nor 'docker-compose' is available."
fi

if command -v lsof >/dev/null 2>&1; then
  LSOF="$(command -v lsof)"
elif [ -x /usr/sbin/lsof ]; then
  LSOF=/usr/sbin/lsof
else
  die "lsof is required to check local port collisions. Install it or restore /usr/sbin to PATH."
fi

running_services=$($COMPOSE ps --services --status running 2>/dev/null || true)
stack_running=yes
for service in bazaar facilitator demo-server; do
  if ! printf '%s\n' "$running_services" | grep -qx "$service"; then
    stack_running=no
    break
  fi
done

requested_bazaar_host_port="${BAZAAR_HOST_PORT:-}"
requested_bazaar_p2p_host_port="${BAZAAR_P2P_HOST_PORT:-}"
requested_bazaar_p2p_ws_host_port="${BAZAAR_P2P_WS_HOST_PORT:-}"
requested_facilitator_host_port="${FACILITATOR_HOST_PORT:-}"
requested_demo_server_host_port="${DEMO_SERVER_HOST_PORT:-}"

# ── 1. accounts ──────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  say "1/4  Creating funded Stellar testnet accounts (Friendbot)"
  [ -d node_modules ] || npm install --no-audit --no-fund
  npm run setup
else
  say "1/4  Using existing .env"
fi

# Make the generated project configuration authoritative for this run. This
# prevents stale exported credentials from another local stack overriding the
# seller identity or facilitator accounts used by the fresh .env.
set -a
. ./.env
set +a
BAZAAR_HOST_PORT="${requested_bazaar_host_port:-${BAZAAR_HOST_PORT:-3001}}"
BAZAAR_P2P_HOST_PORT="${requested_bazaar_p2p_host_port:-${BAZAAR_P2P_HOST_PORT:-4001}}"
BAZAAR_P2P_WS_HOST_PORT="${requested_bazaar_p2p_ws_host_port:-${BAZAAR_P2P_WS_HOST_PORT:-4002}}"
FACILITATOR_HOST_PORT="${requested_facilitator_host_port:-${FACILITATOR_HOST_PORT:-3002}}"
DEMO_SERVER_HOST_PORT="${requested_demo_server_host_port:-${DEMO_SERVER_HOST_PORT:-3003}}"
export BAZAAR_HOST_PORT BAZAAR_P2P_HOST_PORT BAZAAR_P2P_WS_HOST_PORT FACILITATOR_HOST_PORT DEMO_SERVER_HOST_PORT
export BAZAAR_URL="http://localhost:${BAZAAR_HOST_PORT}"
export FACILITATOR_URL="http://localhost:${FACILITATOR_HOST_PORT}"
export DEMO_SERVER_URL="http://localhost:${DEMO_SERVER_HOST_PORT}"

for port in "$BAZAAR_HOST_PORT" "$BAZAAR_P2P_HOST_PORT" "$BAZAAR_P2P_WS_HOST_PORT" "$FACILITATOR_HOST_PORT" "$DEMO_SERVER_HOST_PORT"; do
  "$LSOF" -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || continue
  if [ "$stack_running" = yes ]; then
    echo "     port $port already served by this Compose stack - 'docker compose up' will reuse or replace it"
  else
    holder=$("$LSOF" -nP -iTCP:"$port" -sTCP:LISTEN -F c 2>/dev/null | sed -n 's/^c//p' | head -1)
    die "Port $port is already in use${holder:+ (process: $holder)}.
  Set a different host port in .env or the environment and re-run."
  fi
done

# ── 2. stack ─────────────────────────────────────────────────────────────────
say "2/4  Starting postgres + bazaar + facilitator + demo resource server"
$COMPOSE up --build -d postgres bazaar facilitator demo-server

# ── 3. wait ──────────────────────────────────────────────────────────────────
say "3/4  Waiting for every service to report healthy"
for i in $(seq 1 90); do
  bazaar_ok=$(curl -fsS "${BAZAAR_URL}/health" >/dev/null 2>&1 && echo yes || echo no)
  facilitator_ok=$(curl -fsS "${FACILITATOR_URL}/health" >/dev/null 2>&1 && echo yes || echo no)
  demo_ok=$(curl -fsS "${DEMO_SERVER_URL}/health" >/dev/null 2>&1 && echo yes || echo no)

  if [ "$bazaar_ok" = yes ] && [ "$facilitator_ok" = yes ] && [ "$demo_ok" = yes ]; then
    echo "     bazaar       ${BAZAAR_URL}  ready"
    echo "     facilitator  ${FACILITATOR_URL}  ready"
    echo "     demo server  ${DEMO_SERVER_URL}  ready"
    break
  fi
  if [ "$i" = 90 ]; then
    echo "Services did not become healthy in 90s. Logs:" >&2
    $COMPOSE logs --tail 60 >&2
    exit 1
  fi
  sleep 1
done

# ── 4. pay ───────────────────────────────────────────────────────────────────
say "4/4  Running the conformance harness (stock x402 client, real testnet payment)"
[ -d conformance/node_modules ] || npm --prefix conformance ci --no-audit --no-fund

if ! npm run conformance; then
  cat >&2 <<'HINT'

The harness failed. Two causes are far more likely than a bug in this code:

  1. Stellar testnet was reset, wiping the accounts in .env.
     Fix:  npm run setup -- --force && docker compose up -d && npm run conformance

  2. Soroban RPC was lagging or unreachable. Payments simulate against it, and
     the public endpoint is load-balanced across nodes at different ledger
     heights (x402-foundation/x402#3168). The facilitator retries that specific
     rejection; a re-run usually succeeds.

Facilitator logs:  docker compose logs facilitator
HINT
  exit 1
fi

say "Done. conformance-report.json holds the full run, including the settled transaction."
