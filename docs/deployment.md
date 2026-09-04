# Veridex x402 Stellar Facilitator v2.0 - Deployment Guide

**License:** Apache-2.0

Complete deployment guide for production and development environments.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start (Docker Compose)](#quick-start-docker-compose)
3. [Manual Installation](#manual-installation)
4. [Production Deployment](#production-deployment)
5. [Testing](#testing)
6. [Monitoring](#monitoring)
7. [Troubleshooting](#troubleshooting)

## Prerequisites

### Required

- **Node.js:** 22.x or higher
- **PostgreSQL:** 16.x with pgvector extension
- **Docker & Docker Compose:** Latest stable (for containerized deployment)
- **Stellar Account:** Funded testnet/pubnet account with 100+ XLM

### Optional

- **Rust & Cargo:** For Soroban smart contract compilation
- **Soroban CLI:** For contract deployment

### Generate Stellar Account

**Testnet:**
```bash
# Using Stellar Laboratory
https://laboratory.stellar.org/#account-creator?network=test

# Or using Stellar CLI
stellar keys generate --network testnet --name facilitator
stellar account fund facilitator --network testnet
```

**Pubnet:**
```bash
# Purchase XLM from an exchange and create account
stellar keys generate --network pubnet --name facilitator
# Transfer XLM to the generated address
```

## Quick Start (Docker Compose)

### 1. Clone Repository

```bash
git clone https://github.com/veridex/veridex
cd veridex/packages/stellar-facilitator
```

### 2. Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Edit configuration
nano .env
```

Required configuration:
```bash
FACILITATOR_PUBLIC_KEY=G...  # Your Stellar public key
FACILITATOR_SECRET_KEY=S...  # Your Stellar secret key
STELLAR_NETWORK=testnet      # or pubnet for production
```

### 3. Start Services

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Check service health
curl http://localhost:3001/health  # Bazaar
curl http://localhost:3002/health  # Facilitator
```

### 4. Verify Deployment

```bash
# Test discovery
curl "http://localhost:3001/discovery/search?q=test"

# Check facilitator schemes
curl http://localhost:3002/supported
```

## Manual Installation

### 1. Install PostgreSQL with pgvector

```bash
# macOS (Homebrew)
brew install postgresql@16
brew install pgvector

# Ubuntu/Debian
sudo apt-get install postgresql-16 postgresql-16-pgvector

# Start PostgreSQL
brew services start postgresql@16  # macOS
sudo systemctl start postgresql    # Linux
```

### 2. Create Database

```bash
# Create database
createdb veridex_bazaar

# Install extensions and schema
psql veridex_bazaar < bazaar-service/src/db/schema.sql
```

### 3. Install Node.js Dependencies

```bash
# Root dependencies
npm install

# Bazaar service
cd bazaar-service
npm install
npm run build
cd ..

# Facilitator service
cd facilitator-service
npm install
npm run build
cd ..

# MCP server (optional)
cd mcp-server
npm install
npm run build
cd ..
```

### 4. Configure Services

Create `.env` files for each service:

**bazaar-service/.env:**
```bash
BAZAAR_PORT=3001
BAZAAR_HOST=0.0.0.0

DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=veridex_bazaar
DATABASE_USER=postgres
DATABASE_PASSWORD=yourpassword

P2P_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/4001,/ip4/0.0.0.0/tcp/4002/ws
P2P_BOOTSTRAP_PEERS=
```

**facilitator-service/.env:**
```bash
FACILITATOR_PORT=3002
FACILITATOR_HOST=0.0.0.0

STELLAR_NETWORK=testnet
FACILITATOR_PUBLIC_KEY=G...
FACILITATOR_SECRET_KEY=S...

CHANNEL_POOL_SIZE=0
CHANNEL_SECRET_KEYS=
CHANNEL_AUTO_CREATE=false
CHANNEL_COOLDOWN_MS=5000
CHANNEL_STARTING_BALANCE=5
CHANNEL_REFILL_THRESHOLD=2
CHANNEL_REFILL_AMOUNT=3
```

### 5. Start Services

**Bazaar Service:**
```bash
cd bazaar-service
npm start
```

**Facilitator Service (in new terminal):**
```bash
cd facilitator-service
npm start
```

**MCP Server (optional, in new terminal):**
```bash
cd mcp-server
BAZAAR_URL=http://localhost:3001 \
FACILITATOR_URL=http://localhost:3002 \
STELLAR_NETWORK=testnet \
STELLAR_CLIENT_SECRET_KEY=S... \
npm start
```

## Production Deployment

### Architecture

```
        Internet
           │
           ▼
    ┌──────────────┐
    │  Cloudflare  │  (CDN, DDoS protection)
    │   / nginx    │
    └──────────────┘
           │
      ┌────┴────┐
      │         │
      ▼         ▼
┌─────────┐ ┌──────────┐
│ Bazaar  │ │Facilita  │
│  :3001  │ │tor :3002 │
└─────────┘ └──────────┘
      │         │
      └────┬────┘
           ▼
    ┌──────────────┐
    │  PostgreSQL  │
    │ (Primary +   │
    │  Replica)    │
    └──────────────┘
```

### 1. Secure PostgreSQL

```bash
# Enable SSL
postgresql.conf:
  ssl = on
  ssl_cert_file = '/path/to/server.crt'
  ssl_key_file = '/path/to/server.key'

# Restrict connections
pg_hba.conf:
  hostssl veridex_bazaar all 10.0.0.0/8 scram-sha-256

# Restart PostgreSQL
sudo systemctl restart postgresql
```

### 2. Configure Reverse Proxy

**nginx configuration:**
```nginx
# Bazaar service
upstream bazaar {
    server localhost:3001;
}

# Facilitator service
upstream facilitator {
    server localhost:3002;
}

server {
    listen 443 ssl http2;
    server_name bazaar.veridex.io;

    ssl_certificate /etc/letsencrypt/live/veridex.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/veridex.io/privkey.pem;

    location / {
        proxy_pass http://bazaar;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl http2;
    server_name facilitator.veridex.io;

    ssl_certificate /etc/letsencrypt/live/veridex.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/veridex.io/privkey.pem;

    location / {
        proxy_pass http://facilitator;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 3. Deploy Soroban Contract

```bash
cd contracts/upto-settlement

# Build reproducible WASM with the pinned toolchain
../../scripts/build-upto.sh

# Deploy to pubnet
export STELLAR_SECRET_KEY=S...
stellar contract deploy \
  --wasm target/wasm32v1-none/release/upto_settlement.wasm \
  --source $STELLAR_SECRET_KEY \
  --network pubnet

# Save contract ID
export ESCROW_CONTRACT_ID=C...
```

### 4. Configure P2P Bootstrap Peers

```bash
# Set bootstrap peers for P2P mesh
export P2P_BOOTSTRAP_PEERS=/ip4/1.2.3.4/tcp/4001/p2p/12D3KooW...,/ip4/5.6.7.8/tcp/4001/p2p/12D3KooW...
```

### 5. Production docker-compose.yml

```yaml
version: '3.8'

services:
  postgres:
    image: pgvector/pgvector:pg16
    restart: always
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - veridex-internal

  bazaar:
    image: veridex/bazaar:latest
    restart: always
    ports:
      - "3001:3001"
    environment:
      DATABASE_HOST: postgres
      DATABASE_SSL: "true"
      P2P_BOOTSTRAP_PEERS: ${P2P_BOOTSTRAP_PEERS}
    depends_on:
      - postgres
    networks:
      - veridex-internal

  facilitator:
    image: veridex/facilitator:latest
    restart: always
    ports:
      - "3002:3002"
    environment:
      STELLAR_NETWORK: pubnet
      FACILITATOR_SECRET_KEY: ${FACILITATOR_SECRET_KEY}
      CHANNEL_POOL_SIZE: 100
    networks:
      - veridex-internal

volumes:
  postgres-data:

networks:
  veridex-internal:
    driver: bridge
```

## Testing

### Integration Tests

```bash
# Start test environment
docker-compose up -d

# Wait for services to be healthy
sleep 10

# Run integration tests
cd tests
npm install
npm test
```

### Manual Testing

**Test Discovery:**
```bash
curl -X GET "http://localhost:3001/discovery/search?q=weather&limit=5"
```

**Test Payment Flow:**
```bash
# 1. Get facilitator info
curl http://localhost:3002/supported

# 2. Build and sign transaction (use SDK)
# 3. Submit settlement
curl -X POST http://localhost:3002/settle \
  -H "Content-Type: application/json" \
  -d '{
    "scheme": "stellar",
    "network": "testnet",
    "resourceServer": "G...",
    "transactionXdr": "..."
  }'
```

### Load Testing

```bash
# Install k6
brew install k6

# Run load test
k6 run tests/load/search-load.js
```

## Monitoring

### Metrics

Prometheus metrics available at:
- **Bazaar:** `http://localhost:3001/metrics`
- **Facilitator:** `http://localhost:3002/metrics`

### Key Metrics

```
# Bazaar
veridex_search_requests_total
veridex_search_latency_seconds
veridex_p2p_peers
veridex_telemetry_nodes_tracked

# Facilitator
veridex_settlement_requests_total
veridex_settlement_success_total
veridex_channel_pool_available
veridex_channel_pool_in_use
```

### Grafana Dashboard

Import dashboard template:
```bash
# Dashboard JSON available at: dashboards/veridex-overview.json
```

### Log Aggregation

```bash
# Configure log shipping
docker-compose.yml:
  logging:
    driver: "json-file"
    options:
      max-size: "10m"
      max-file: "3"
      labels: "service"
```

## Troubleshooting

### Common Issues

**1. Database connection failed**

```bash
# Check PostgreSQL is running
pg_isready

# Check pgvector extension
psql veridex_bazaar -c "SELECT * FROM pg_extension WHERE extname = 'vector';"

# Verify connection string
psql "host=localhost port=5432 dbname=veridex_bazaar user=postgres"
```

**2. Channel pool initialization fails**

```bash
# Check facilitator account balance
stellar account get FACILITATOR_PUBLIC_KEY --network testnet

# Verify funding (need 250+ XLM for 50 channels @ 5 XLM each)
# If insufficient, fund the account
```

**3. P2P mesh not connecting**

```bash
# Check listen address is accessible
netstat -an | grep 4001

# Verify bootstrap peers are reachable
telnet 1.2.3.4 4001

# Check firewall rules
sudo ufw status
```

**4. Settlement transactions failing**

```bash
# Check Horizon status
curl https://horizon-testnet.stellar.org/

# Verify transaction XDR format
stellar xdr decode --type TransactionEnvelope <XDR>

# Check account sequence
stellar account get ACCOUNT --network testnet
```

### Debug Mode

```bash
# Enable debug logging
export LOG_LEVEL=debug
export DEBUG=veridex:*

# Start services
npm start
```

### Health Checks

```bash
# Bazaar health
curl http://localhost:3001/health | jq

# Facilitator health
curl http://localhost:3002/health | jq

# Check all components
./scripts/health-check.sh
```

## Security Best Practices

1. **Secret Management**
   - Use environment variables or secret management service (Vault, AWS Secrets Manager)
   - Never commit `.env` files
   - Rotate keys quarterly

2. **Network Security**
   - Enable firewall rules
   - Use VPC/private networks
   - Restrict database access to application servers only

3. **Monitoring & Alerts**
   - Set up alerts for failed settlements
   - Monitor channel account balances
   - Track error rates

4. **Backups**
   - Daily PostgreSQL backups
   - Test restoration procedure monthly
   - Store backups in separate region/datacenter

## Support

- **Documentation:** https://docs.veridex.io
- **Issues:** https://github.com/veridex/veridex/issues
- **Discord:** https://discord.gg/veridex

## License

Apache-2.0
