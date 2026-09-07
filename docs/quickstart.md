# Stellar testnet quickstart

This is the canonical clean-clone path for one real Stellar x402 v2 `exact`
payment and Bazaar discovery. It does not require understanding federation,
provider quality, channel internals, or the `upto` contract.

## Prerequisites

- Node.js 22 or newer
- Docker with Compose
- `curl` and `lsof`
- Network access to Stellar testnet, Friendbot, and npm

## One command

```bash
git clone https://github.com/Veridex-Protocol/stellar-facilitator.git
cd stellar-facilitator
npm run demo
```

`npm run demo` performs the following steps:

1. Installs the root dependencies when needed.
2. Creates facilitator, seller, buyer, and three channel keypairs.
3. Funds every account with Friendbot and waits for Soroban RPC visibility.
4. Writes `.env` with mode `0600`.
5. Starts PostgreSQL, Bazaar, facilitator, and reference seller with Compose.
6. Waits for all three HTTP services to report healthy.
7. Runs the stock x402 v2 `exact` conformance flow and custom direct `upto`
   checks enabled by the configured testnet contract.
8. Re-reads successful transactions from Stellar and writes
   `conformance-report.json`.

No pubnet/mainnet transaction is performed.

## Expected services

```bash
curl -fsS http://localhost:3001/health
curl -fsS http://localhost:3002/health
curl -fsS http://localhost:3003/health
```

| Service | URL |
|---|---|
| Bazaar | `http://localhost:3001` |
| Facilitator | `http://localhost:3002` |
| Reference seller | `http://localhost:3003` |

The conformance command prints a settled transaction and ends with zero failed
checks. The machine-readable result is `conformance-report.json`.

## Inspect the 402

The unpaid reference route is:

```bash
curl -sS -D /tmp/veridex-headers -o /tmp/veridex-body \
  http://localhost:3003/paid-resource
grep -i '^payment-required:' /tmp/veridex-headers
```

Decode the x402 v2 `PaymentRequired` value:

```bash
awk -F': ' 'tolower($1)=="payment-required" {print $2}' /tmp/veridex-headers \
  | tr -d '\r' | base64 -d | jq
```

The decoded value has `x402Version: 2`, `resource`, `accepts`, and optional
`extensions`. Each accepted `PaymentRequirements` uses `amount`, not the v1
field `maxAmountRequired`.

## Inspect discovery

After the successful settlement, catalog delivery is asynchronous. Poll until
the settlement-backed row appears:

```bash
curl -fsS \
  "http://localhost:3001/discovery/resources?network=stellar:testnet&limit=20" \
  | jq '.results[] | {resourceUrl, scheme, network, payTo}'
```

Search the catalog:

```bash
curl -fsS \
  "http://localhost:3001/discovery/search?q=payment&network=stellar:testnet&limit=5" \
  | jq '{total, partialResults, results}'
```

Discovery is a recommendation. The paid request still trusts only the signed
payment requirements and authorization.

## Repeat from a fresh state

The following removes only this Compose project's containers/volumes and its
generated testnet configuration, then creates new Friendbot accounts and a new
database:

```bash
docker compose down -v --remove-orphans
rm -f .env
npm run demo
```

Stellar testnet resets invalidate old `.env` accounts. Regenerate without
manually deleting the file with:

```bash
npm run setup -- --force
docker compose up --build -d postgres bazaar facilitator demo-server
npm run conformance
```

## Port conflicts

Choose alternate host ports before running the demo:

```bash
BAZAAR_HOST_PORT=3201 \
BAZAAR_P2P_HOST_PORT=4201 \
BAZAAR_P2P_WS_HOST_PORT=4202 \
FACILITATOR_HOST_PORT=3202 \
DEMO_SERVER_HOST_PORT=3203 \
npm run demo
```

The generated internal Compose service ports remain unchanged; the harness uses
the selected public URLs.

## Next paths

- [Buyer](guide/buyer.md)
- [Seller](guide/seller.md)
- [Agent](guide/agent.md)
- [Operator](guide/operator.md)
- [Veridex custom `upto`](specifications/scheme_upto_stellar.md)
