# Veridex x402 Conformance Harness

End-to-end conformance validation suite for Stellar x402 facilitators, Bazaar discovery, and payment schemes.

---

## Overview

The conformance harness is an independent test runner that interacts with the facilitator and discovery service strictly over HTTP wire protocols, mimicking an external unmodified client using stock `@x402/stellar` client libraries.

It validates:
1. Canonical `/supported` endpoint response structure, including `areFeesSponsored` and scheme descriptors.
2. Complete HTTP 402 challenge, client authorization signing, facilitator verification, and on-chain settlement.
3. Post-settlement Horizon ledger re-reading to verify that transaction hashes correspond to actual confirmed balance movements.
4. Bazaar auto-cataloging verification via the `EXTENSION-RESPONSES` header.
5. Discovery search and pagination checks.

---

## Running the Conformance Suite

### Prerequisites
Make sure the stack is running (facilitator on port 3002, bazaar on port 3001, demo-server on port 4020).

### Run Harness
```bash
node conformance/src/harness.mjs
```

Results are printed to the terminal and written to `conformance-report.json`.
