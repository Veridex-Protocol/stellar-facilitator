#!/usr/bin/env bash
# Veridex Stellar Facilitator - reproducible dependency installation
# License: Apache-2.0

set -euo pipefail

cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || {
    printf '%s\n' "Node.js 22 or newer is required." >&2
    exit 1
}

command -v npm >/dev/null 2>&1 || {
    printf '%s\n' "npm is required." >&2
    exit 1
}

npm run install:all

printf '\nDependencies installed from the repository lockfiles.\n'
printf 'Next: npm run demo\n'
printf 'The optional Python SDK and Soroban contract toolchain have separate setup requirements documented in docs/.\n'
echo ""
