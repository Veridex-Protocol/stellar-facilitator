# Veridex Demo Protected Resource Server

Reference implementation of an x402-protected HTTP resource server that sells an API endpoint and advertises itself to the Veridex Bazaar.

---

## Overview

The Demo Server demonstrates how a seller configures HTTP 402 payment protection and discovery metadata using standard middleware:
1. Returns HTTP 402 with payment requirements for unauthorized requests.
2. Accepts base64 x402 v2 `PaymentPayload` retry requests in `PAYMENT-SIGNATURE`.
3. Forwards payment authorizations to the Facilitator Service for `/verify` and `/settle`.
4. Declares Bazaar metadata in `PaymentRequired.extensions`; the client echoes it in `PaymentPayload`, and confirmed settlement queues asynchronous cataloging.

---

## Running the Demo Server

```bash
npm --prefix demo-server run dev
```

Listening on `http://localhost:3003` by default.

Routes:

- `GET /paid-resource` - stock Stellar `exact`
- `GET /paid-resource-upto` - custom experimental Veridex `upto`
- `GET /health` - readiness
