#!/usr/bin/env bash
#
# Builds and deploys the upto settlement contract to your own account.
#
# No contract id ships as a default, including ours: an operator who wants the
# upto scheme deploys their own instance. The contract is stateless and has no
# privileged party, so every instance of the same wasm behaves identically.
#
# License: Apache-2.0
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK="${STELLAR_NETWORK:-testnet}"
RPC="${SOROBAN_RPC_URL:-https://soroban-testnet.stellar.org}"
PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
WASM="contracts/upto-settlement/target/wasm32v1-none/release/upto_settlement.wasm"

command -v stellar >/dev/null 2>&1 || {
  echo "The Stellar CLI is required: https://developers.stellar.org/docs/tools/cli" >&2
  exit 1
}

[ -f .env ] || { echo "No .env - run 'npm run setup' first." >&2; exit 1; }
SECRET=$(grep '^FACILITATOR_SECRET_KEY=' .env | cut -d= -f2)
[ -n "$SECRET" ] || { echo "FACILITATOR_SECRET_KEY is not set in .env" >&2; exit 1; }

printf '\n1/3  Building the contract\n'
"$(dirname "$0")/build-upto.sh"
HASH=$(shasum -a 256 "$WASM" | awk '{print $1}')
printf '     wasm sha256 %s\n' "$HASH"

printf '\n2/3  Uploading the wasm to %s\n' "$NETWORK"
UPLOADED=$(stellar contract upload --wasm "$WASM" --source-account "$SECRET" \
  --rpc-url "$RPC" --network-passphrase "$PASSPHRASE" 2>/dev/null | tail -1)

# The network computes the hash independently. If it disagrees with ours, the
# artifact we tested is not the artifact we uploaded.
if [ "$UPLOADED" != "$HASH" ]; then
  echo "Uploaded hash $UPLOADED does not match the local build $HASH." >&2
  exit 1
fi
printf '     confirmed on-chain: %s\n' "$UPLOADED"

printf '\n3/3  Instantiating\n'
CONTRACT=$(stellar contract deploy --wasm-hash "$HASH" --source-account "$SECRET" \
  --rpc-url "$RPC" --network-passphrase "$PASSPHRASE" 2>/dev/null | tail -1)

VAR="UPTO_ESCROW_CONTRACT_ID_$(echo "$NETWORK" | tr '[:lower:]' '[:upper:]')"
printf '\nDeployed: %s\n\n' "$CONTRACT"
printf 'Add this to .env, then restart the facilitator:\n  %s=%s\n\n' "$VAR" "$CONTRACT"
printf 'The facilitator confirms the contract exists on-chain before it will\n'
printf 'advertise the upto scheme on /supported.\n'
