# Veridex Demo Protected Resource Server

Reference implementation of an x402-protected HTTP resource server that sells an API endpoint and advertises itself to the Veridex Bazaar.

---

## Overview

The Demo Server demonstrates how a seller configures HTTP 402 payment protection and discovery metadata using standard middleware:
1. Returns HTTP 402 with payment requirements for unauthorized requests.
2. Accepts `Authorization: Bearer <PaymentPayload>` retry requests.
3. Forwards payment authorizations to the Facilitator Service for `/verify` and `/settle`.
4. Emits Bazaar discovery metadata (`serviceName`, `description`, `tags`, `routeTemplate`) on the payment payload to trigger automatic catalog listing upon settlement.

---

## Running the Demo Server

```bash
npm --prefix demo-server run dev
```

Listening on `http://localhost:4020`.
