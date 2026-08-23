#!/usr/bin/env bash
#
# Builds the upto settlement contract reproducibly.
#
# The toolchain is pinned because the wasm hash is what an operator publishes and
# a facilitator verifies; a different compiler produces a different artifact.
#
# License: Apache-2.0
set -euo pipefail
cd "$(dirname "$0")/../contracts/upto-settlement"

TOOLCHAIN=$(grep '^channel' rust-toolchain.toml | cut -d'"' -f2)

command -v rustup >/dev/null 2>&1 || {
  echo "rustup is required to pin the toolchain: https://rustup.rs" >&2
  exit 1
}

rustup toolchain list | grep -q "$TOOLCHAIN" || \
  rustup toolchain install "$TOOLCHAIN" --profile minimal
rustup target list --toolchain "$TOOLCHAIN" --installed | grep -q wasm32v1-none || \
  rustup target add wasm32v1-none --toolchain "$TOOLCHAIN"

cargo "+$TOOLCHAIN" build --release --target wasm32v1-none
shasum -a 256 target/wasm32v1-none/release/upto_settlement.wasm
