/**
 * Settling an `upto` payment against a deployed settlement contract.
 * License: Apache-2.0
 *
 * This is the client half of the `upto` scheme, written against the public
 * Stellar SDK and the contract's published interface. It exists so the
 * conformance harness can demonstrate a metered settlement end to end rather
 * than only assert that the scheme is advertised.
 *
 * Two authorizations are required and they are signed by different parties. The
 * payer signs the eight terms it is agreeing to; the facilitator signs the
 * amount it is charging and a digest of what it delivered. Neither can vary the
 * other's half, which is the property the scheme exists to provide.
 */

import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  authorizeEntry,
  hash,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const BASE_FEE = "1000000";

/**
 * Builds a Soroban struct value: a map keyed by sorted field-name symbols.
 *
 * `nativeToScVal` on a plain object produces string keys, which a
 * `#[contracttype]` struct does not accept. Soroban also requires map keys in
 * sorted order.
 *
 * @param fields - Field name to already-converted ScVal
 * @returns The struct as an ScVal map
 */
function struct(fields) {
  const entries = Object.keys(fields)
    .sort()
    .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] }));
  return xdr.ScVal.scvMap(entries);
}

/** @param value - Stellar address string @returns Address ScVal */
const addr = (value) => new Address(value).toScVal();
/** @param value - Integer or bigint @returns i128 ScVal */
const i128 = (value) => nativeToScVal(BigInt(value), { type: "i128" });
/** @param value - Integer @returns u32 ScVal */
const u32 = (value) => nativeToScVal(value, { type: "u32" });
/** @param buf - 32-byte buffer @returns BytesN<32> ScVal */
const bytes32 = (buf) => xdr.ScVal.scvBytes(buf);

/**
 * Settles a metered payment.
 *
 * @param options - Contract, network, parties, terms and the amount charged
 * @returns The settlement result plus the transaction hash
 * @throws {Error} When simulation or submission fails
 */
export async function settleUpto({
  contractId,
  rpcUrl,
  networkPassphrase = Networks.TESTNET,
  payerSecret,
  facilitatorSecret,
  payTo,
  token,
  maxAmount,
  actual,
  settlementId,
  requestDigest,
  resultDigest,
  horizonUrl = "https://horizon-testnet.stellar.org",
  validityLedgers = 100,
}) {
  const server = new SorobanRpc.Server(rpcUrl);
  const payerKp = Keypair.fromSecret(payerSecret);
  const facilitatorKp = Keypair.fromSecret(facilitatorSecret);

  const { sequence } = await server.getLatestLedger();
  const validAfter = Math.max(0, sequence - 1);
  const deadline = sequence + validityLedgers;

  const terms = struct({
    pay_to: addr(payTo),
    token: addr(token),
    max_amount: i128(maxAmount),
    valid_after: u32(validAfter),
    deadline: u32(deadline),
    facilitator: addr(facilitatorKp.publicKey()),
    settlement_id: bytes32(settlementId),
    request_digest: bytes32(requestDigest),
  });

  const attestation = struct({
    settlement_id: bytes32(settlementId),
    actual: i128(actual),
    result_digest: bytes32(resultDigest),
  });

  // The facilitator is the transaction source and pays the network fee, which
  // is the same fee-sponsorship posture as the exact scheme.
  const source = await server.getAccount(facilitatorKp.publicKey());
  const contract = new Contract(contractId);

  const built = new TransactionBuilder(
    new Account(source.accountId(), source.sequenceNumber()),
    { fee: BASE_FEE, networkPassphrase },
  )
    .addOperation(contract.call("settle", addr(payerKp.publicKey()), terms, attestation))
    .setTimeout(180)
    .build();

  const simulated = await server.simulateTransaction(built);
  if (SorobanRpc.Api.isSimulationError(simulated)) {
    throw new Error(`upto simulation failed: ${simulated.error}`);
  }

  // Each party signs only its own authorization entry. Entries are matched by
  // the address they belong to, never by position.
  const signedAuth = await Promise.all(
    (simulated.result?.auth ?? []).map(async (entry) => {
      if (entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
        return entry;
      }
      const who = Address.fromScAddress(entry.credentials().address().address()).toString();
      const signer =
        who === payerKp.publicKey() ? payerKp : who === facilitatorKp.publicKey() ? facilitatorKp : null;
      if (!signer) throw new Error(`unexpected authorization required from ${who}`);

      // The callback receives the HashIdPreimage, not raw bytes: sign its hash.
      return authorizeEntry(
        entry,
        async (preimage) => signer.sign(hash(preimage.toXDR())),
        deadline,
        networkPassphrase,
      );
    }),
  );

  const authorized = new TransactionBuilder(
    new Account(source.accountId(), source.sequenceNumber()),
    { fee: BASE_FEE, networkPassphrase },
  )
    .addOperation(
      contract.call("settle", addr(payerKp.publicKey()), terms, attestation),
    )
    .setTimeout(180)
    .build();

  // Re-simulate with the signed authorizations so the footprint and resource
  // fee account for them.
  const prepared = SorobanRpc.assembleTransaction(
    authorized,
    await server.simulateTransaction(
      applyAuth(authorized, signedAuth, networkPassphrase),
    ),
  ).build();

  const withAuth = applyAuth(prepared, signedAuth, networkPassphrase);
  withAuth.sign(facilitatorKp);

  const sent = await server.sendTransaction(withAuth);
  if (sent.status === "ERROR") {
    throw new Error(`upto submission rejected: ${JSON.stringify(sent.errorResult)}`);
  }

  // Confirm on Horizon rather than through the RPC's transaction parser. It is
  // the same independent read the exact-scheme checks use, it does not depend
  // on this SDK version being able to decode the newest transaction meta, and
  // it is the record a third party would consult anyway.
  const confirmed = await confirmOnHorizon(sent.hash, horizonUrl);

  return {
    hash: sent.hash,
    ledger: confirmed.ledger,
    createdAt: confirmed.created_at,
    validAfter,
    deadline,
  };
}

/**
 * Waits for a transaction to appear on Horizon and confirms it succeeded.
 *
 * @param hash - Transaction hash
 * @param horizonUrl - Horizon endpoint
 * @param attempts - Polling attempts
 * @returns The Horizon transaction record
 * @throws {Error} When it never appears, or appears as failed
 */
async function confirmOnHorizon(hash, horizonUrl, attempts = 30) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(`${horizonUrl}/transactions/${hash}`);
    if (response.ok) {
      const record = await response.json();
      if (record.successful !== true) {
        throw new Error(`upto settlement ${hash} was rejected by the network`);
      }
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`upto settlement ${hash} never appeared on Horizon`);
}

/**
 * Reads whether an authorization has already settled.
 *
 * @param options - Contract, RPC endpoint, network, payer and settlement id
 * @returns True when the authorization has been consumed
 */
export async function isSettled({
  contractId,
  rpcUrl,
  networkPassphrase = Networks.TESTNET,
  readerSecret,
  payer,
  settlementId,
}) {
  const server = new SorobanRpc.Server(rpcUrl);
  const reader = Keypair.fromSecret(readerSecret);
  const source = await server.getAccount(reader.publicKey());

  const built = new TransactionBuilder(
    new Account(source.accountId(), source.sequenceNumber()),
    { fee: BASE_FEE, networkPassphrase },
  )
    .addOperation(
      new Contract(contractId).call("is_settled", addr(payer), bytes32(settlementId)),
    )
    .setTimeout(60)
    .build();

  const simulated = await server.simulateTransaction(built);
  if (SorobanRpc.Api.isSimulationError(simulated)) {
    throw new Error(`is_settled simulation failed: ${simulated.error}`);
  }
  return scValToNative(simulated.result.retval);
}

/**
 * Returns a copy of a transaction with the given authorization entries applied.
 *
 * @param transaction - The built transaction
 * @param auth - Signed authorization entries
 * @param networkPassphrase - Network passphrase
 * @returns A transaction carrying the signed authorizations
 */
function applyAuth(transaction, auth, networkPassphrase) {
  const envelope = transaction.toEnvelope();
  const tx = envelope.v1().tx();
  const op = tx.operations()[0];
  op.body().invokeHostFunctionOp().auth(auth);
  return TransactionBuilder.fromXDR(envelope.toXDR("base64"), networkPassphrase);
}
