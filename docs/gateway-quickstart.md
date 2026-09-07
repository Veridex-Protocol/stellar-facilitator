# Gateway quickstart

Use the gateway when the API already exists and native middleware changes are
undesirable. Use the [native seller path](guide/seller.md) when the application
needs response-aware settlement or custom usage logic.

## Repository demo

```bash
npm run setup
docker compose up --build -d postgres bazaar facilitator demo-server gateway playground
curl -i http://localhost:3005/hello
```

The final command must return HTTP 402 with `PAYMENT-REQUIRED`. Open the
Playground at `http://localhost:3004`, choose **API Gateway**, activate the
controlled demo, and complete the real browser-signed testnet payment.

## Existing API in four steps

1. Build the package: `npm --prefix gateway-service run build`.
2. Run `npm --prefix gateway-service run init` and answer the upstream,
   public gateway URL, facilitator, `payTo`, asset, and atomic price prompts.
3. Set `GATEWAY_CONFIG=gateway.config.json` and optional
   `PROVIDER_OUTCOME_SECRET_KEY`, then run
   `npm --prefix gateway-service start`.
4. Request the configured public route and pay its canonical x402 v2 challenge
   with `@veridex/stellar` or an official x402 Stellar client.

The generated file is mode `0600`. It contains no payer key and no upstream
credential. HTTPS is required by default.

## Clean-room target

For a public HTTPS API with DNS and TLS already configured, the intended path
is under 15 minutes:

```text
install/build (3 minutes)
-> guided configuration (3 minutes)
-> DNS/TLS route to port 3005 (5 minutes)
-> request 402 and pay on testnet (4 minutes)
```

External DNS/TLS setup, seller account funding/trustline setup, and testnet
network latency are still manual. These are the main V1 DX costs.