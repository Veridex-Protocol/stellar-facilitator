# Veridex upto_escrow Soroban Contract

**License:** Apache-2.0

Metered billing escrow smart contract for x402 resource access on Stellar.

## Overview

This Soroban contract enables pay-per-use resource access with escrow-based metering:

1. **Client deposits XLM** into escrow for a specific resource server
2. **Resource server settles charges** per-request as resources are consumed
3. **Resource server claims** accumulated charges periodically
4. **Client withdraws** unused balance when done

## Features

- ✅ **Escrow deposits** - Clients pre-fund access with XLM
- ✅ **Per-request settlement** - Resource servers charge for each API call
- ✅ **Usage tracking** - Tracks balance, consumed amount, request count
- ✅ **Duplicate prevention** - Request IDs prevent double-charging
- ✅ **Claim & withdraw** - Servers claim earnings, clients recover unused funds
- ✅ **Authorization** - Stellar signature-based auth for all operations

## Contract Functions

### `initialize(admin: Address)`
Initialize contract with admin address (one-time).

### `deposit(client: Address, resource_server: Address, amount: i128) -> EscrowAccount`
Client deposits XLM into escrow for resource access.

**Arguments:**
- `client` - Client's Stellar address
- `resource_server` - Resource server's Stellar address
- `amount` - Amount in stroops (1 XLM = 10,000,000 stroops)

**Returns:** `EscrowAccount` with updated balance

**Authorization:** Requires `client` signature

---

### `settle(client: Address, resource_server: Address, request_id: Symbol, amount: i128, resource_id: Symbol) -> SettlementRecord`
Resource server settles a request and charges the escrow.

**Arguments:**
- `client` - Client address
- `resource_server` - Resource server address
- `request_id` - Unique request identifier (prevents duplicates)
- `amount` - Amount to charge in stroops
- `resource_id` - Resource identifier (URL hash or tool name)

**Returns:** `SettlementRecord` with settlement details

**Authorization:** Requires `resource_server` signature

**Errors:**
- `InsufficientBalance` - Escrow balance too low
- `DuplicateRequest` - Request ID already settled
- `EscrowNotFound` - No escrow account exists

---

### `claim(resource_server: Address, client: Address) -> i128`
Resource server claims accumulated charges.

**Arguments:**
- `resource_server` - Resource server address
- `client` - Client address

**Returns:** Amount claimed (stroops)

**Authorization:** Requires `resource_server` signature

---

### `withdraw(client: Address, resource_server: Address) -> i128`
Client withdraws unused balance.

**Arguments:**
- `client` - Client address
- `resource_server` - Resource server address

**Returns:** Amount withdrawn (stroops)

**Authorization:** Requires `client` signature

---

### `get_escrow(client: Address, resource_server: Address) -> Option<EscrowAccount>`
Query escrow account details (read-only).

**Returns:**
```rust
EscrowAccount {
    client: Address,
    resource_server: Address,
    balance: i128,        // Remaining balance (stroops)
    consumed: i128,       // Accumulated charges awaiting claim (stroops)
    request_count: u32,   // Number of settled requests
    last_activity: u64,   // Unix timestamp
}
```

---

### `get_settlement(client: Address, resource_server: Address, request_id: Symbol) -> Option<SettlementRecord>`
Query settlement record by request ID (read-only).

**Returns:**
```rust
SettlementRecord {
    request_id: Symbol,
    amount: i128,
    timestamp: u64,
    resource_id: Symbol,
}
```

## Usage Example

### 1. Deploy Contract

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/upto_escrow.wasm \
  --source ADMIN_SECRET_KEY \
  --network testnet
```

### 2. Initialize

```bash
soroban contract invoke \
  --id CONTRACT_ID \
  --source ADMIN_SECRET_KEY \
  --network testnet \
  -- initialize \
  --admin ADMIN_PUBLIC_KEY
```

### 3. Client Deposits 10 XLM

```bash
soroban contract invoke \
  --id CONTRACT_ID \
  --source CLIENT_SECRET_KEY \
  --network testnet \
  -- deposit \
  --client CLIENT_PUBLIC_KEY \
  --resource_server SERVER_PUBLIC_KEY \
  --amount 100000000
```

### 4. Server Settles Request (0.01 XLM)

```bash
soroban contract invoke \
  --id CONTRACT_ID \
  --source SERVER_SECRET_KEY \
  --network testnet \
  -- settle \
  --client CLIENT_PUBLIC_KEY \
  --resource_server SERVER_PUBLIC_KEY \
  --request_id "req_12345" \
  --amount 100000 \
  --resource_id "tool_search"
```

### 5. Server Claims Earnings

```bash
soroban contract invoke \
  --id CONTRACT_ID \
  --source SERVER_SECRET_KEY \
  --network testnet \
  -- claim \
  --resource_server SERVER_PUBLIC_KEY \
  --client CLIENT_PUBLIC_KEY
```

### 6. Client Withdraws Remaining Balance

```bash
soroban contract invoke \
  --id CONTRACT_ID \
  --source CLIENT_SECRET_KEY \
  --network testnet \
  -- withdraw \
  --client CLIENT_PUBLIC_KEY \
  --resource_server SERVER_PUBLIC_KEY
```

## Build & Test

```bash
# Build contract
cargo build --target wasm32-unknown-unknown --release

# Run tests
cargo test

# Optimize WASM
soroban contract optimize \
  --wasm target/wasm32-unknown-unknown/release/upto_escrow.wasm
```

## Integration with Facilitator Service

The Facilitator Service (Phase 2) handles direct XLM payments for immediate settlement. This contract provides an **optional** escrow-based model for:

- High-frequency API access (avoid per-request transactions)
- Prepaid resource subscriptions
- Usage-based billing with periodic settlement

### TypeScript Integration

```typescript
import * as SorobanClient from 'soroban-client';

const contract = new SorobanClient.Contract(CONTRACT_ID);

// Deposit
const depositTx = new SorobanClient.TransactionBuilder(sourceAccount, { fee: BASE_FEE })
  .addOperation(
    contract.call(
      'deposit',
      SorobanClient.Address.fromString(clientPubKey).toScVal(),
      SorobanClient.Address.fromString(serverPubKey).toScVal(),
      SorobanClient.nativeToScVal(100_000_000, { type: 'i128' })
    )
  )
  .setTimeout(30)
  .build();
```

## Storage & TTL

- **Persistent storage** - Escrow accounts (30-day TTL, auto-extended)
- **Temporary storage** - Settlement records (1-day TTL for deduplication)

## Security Considerations

1. **Authorization** - All state-changing operations require Stellar signatures
2. **Duplicate prevention** - Request IDs stored in temporary storage prevent double-charging
3. **Balance checks** - Settlement fails if escrow balance insufficient
4. **Separate balances** - `balance` (unused) and `consumed` (pending claim) tracked separately
5. **No admin backdoor** - Admin can only initialize; cannot withdraw or modify escrows

## License

Apache-2.0
