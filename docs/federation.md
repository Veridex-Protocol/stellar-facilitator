# Bazaar federation

**Current status: locally process-proven, not multi-operator proven.** Production
federation is not claimed.

## Trust model

- libp2p peer ID is transport identity.
- Stellar owner/delegate signature is listing authority.
- A signed announcement is discovery data, not payment authorization.
- Catalog admission still requires settlement proof and live payment-term
  integrity; a peer signature does not bypass those checks.

## Signed catalog deltas

`veridex/bazaar/catalog-delta/1` uses full snapshots for `upsert` and a null
state for `revoke`. Security-relevant fields include resource/tool key,
`payTo`, network, scheme/asset/amount, settlement evidence, revision, issuance,
expiry, signer, and signature.

Peers verify:

- schema and Ed25519 signature;
- owner or configured delegate authority;
- expected resource/payee/network binding where supplied;
- bounded lifetime and future/stale timestamps;
- deterministic conflict order: greater revision wins, then canonical digest.

This makes delayed/out-of-order delivery converge deterministically within the
tested process model.

## Heartbeats

Current v2 heartbeat signatures cover the canonical metadata payload, freshness,
and sequence. For compatibility, the runtime still accepts a legacy signature
over `resourceUrl:timestamp:sequence`. Legacy heartbeats are liveness evidence,
not authority for arbitrary metadata changes. Removing this fallback is a
production hardening gate.

Replay/sequence caches are process-local and expire. PostgreSQL stores catalog
delta state/audit records, but multi-process durable heartbeat replay protection
is not established.

## Proven scope

- signed delta verification and unauthorized signer rejection;
- replay/order/conflict/revoke/restore tests;
- one repeatable three-process/three-database libp2p lifecycle with distinct
  peer identities, deterministic conflict convergence, restart retention,
  revoke, and restore;
- separation of peer transport identity from owner/delegate authority.

Not proven:

- independently operated nodes;
- production peer scoring or Sybil resistance;
- durable heartbeat replay state;
- production SLOs, incident response, or public availability.

Mesh failure does not block settlement or local Bazaar search. Federation is an
optional discovery path, never settlement authority.

Run the disposable local proof with `npm run federation:proof`. It reuses the
existing successful testnet settlement in `conformance-report.json` and does
not submit a new chain transaction. Its secret-free result is stored in
`docs/rfp/federation-process-proof-2026-09-07.json`.
