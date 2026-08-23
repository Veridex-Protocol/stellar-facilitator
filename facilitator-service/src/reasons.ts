/**
 * Veridex Facilitator Service - Rejection Reason Mapping
 * License: Apache-2.0
 *
 * `@x402/core` and `@x402/stellar` return machine-readable reason codes and, on
 * most paths, no human-readable message. The spec permits that. It also makes
 * the facilitator unusable for whoever is integrating against it at 2am with
 * nothing but `{"isValid":false,"invalidReason":"invalid_exact_stellar_payload_
 * event_wrong_to"}` on their screen.
 *
 * Every code the pinned packages can emit is mapped to a sentence here, and the
 * HTTP layer refuses to return a rejection carrying only one of the two.
 * `__tests__/reasons.test.ts` asserts this table stays exhaustive against the
 * codes actually present in the installed packages.
 */

/** Reasons produced by this service rather than by the x402 packages. */
export const LOCAL_REASONS = {
  INVALID_REQUEST_BODY: "invalid_request_body",
  UNSUPPORTED_SCHEME_OR_NETWORK: "unsupported_scheme_or_network",
  UPSTREAM_RPC_UNAVAILABLE: "upstream_rpc_unavailable",
  SETTLEMENT_CAPACITY_EXCEEDED: "settlement_capacity_exceeded",
  FACILITATOR_INTERNAL_ERROR: "facilitator_internal_error",
} as const;

/**
 * The one rejection worth retrying.
 *
 * Client and facilitator each read the current ledger from Soroban RPC and
 * independently compute how far ahead an authorization may expire. The public
 * testnet endpoint load-balances across nodes at different heights, while
 * `@x402/stellar` tolerates only a small disagreement. When the client's read
 * lands on a node ahead of ours, a valid payment is rejected as expiring too
 * far in the future. Upstream: x402-foundation/x402#3168.
 */
export const LEDGER_SKEW_REASON = "invalid_exact_stellar_signature_expiration_too_far";

export const REASON_MESSAGES: Readonly<Record<string, string>> = {
  // ── This service ───────────────────────────────────────────────────────────
  [LOCAL_REASONS.INVALID_REQUEST_BODY]:
    "The request body is not a well-formed x402 verify/settle request: it must be JSON carrying 'paymentPayload' and 'paymentRequirements' objects.",
  [LOCAL_REASONS.UNSUPPORTED_SCHEME_OR_NETWORK]:
    "This facilitator does not handle the requested scheme/network pair. See GET /supported for what it does handle.",
  [LOCAL_REASONS.UPSTREAM_RPC_UNAVAILABLE]:
    "The Soroban RPC endpoint could not be reached, so the payment could not be simulated or submitted. This is a facilitator-side outage, not a problem with your payment.",
  [LOCAL_REASONS.SETTLEMENT_CAPACITY_EXCEEDED]:
    "Every settlement signer this facilitator holds was already submitting a transaction, and none freed up in time. Nothing was submitted and no funds moved; retry shortly. Concurrency is bounded by the number of funded channel accounts the operator has provisioned.",
  [LOCAL_REASONS.FACILITATOR_INTERNAL_ERROR]:
    "The facilitator hit an unexpected internal error while processing this request. The payment was not settled.",

  // ── Protocol level (@x402/core) ────────────────────────────────────────────
  invalid_x402_version:
    "The payment payload declares an x402 protocol version this facilitator does not implement. This facilitator speaks x402 v2.",
  unsupported_scheme:
    "The payment scheme named in the requirements is not supported by this facilitator.",
  network_mismatch:
    "The network in the payment payload does not match the network in the payment requirements.",
  invalid_network: "The requested network is not a Stellar network this facilitator serves.",
  verification_failed:
    "The payment failed verification and was not settled. Call /verify to see which specific check failed.",
  settle_failed: "Settlement did not complete. No payment was recorded on the ledger.",
  unexpected_verify_error:
    "Verification failed for an unexpected reason inside the Stellar scheme implementation.",
  unexpected_settle_error:
    "Settlement failed for an unexpected reason inside the Stellar scheme implementation.",

  // ── Payload structure (@x402/stellar, exact) ───────────────────────────────
  invalid_exact_stellar_payload_malformed:
    "The 'transaction' field is not a decodable base64 Stellar transaction envelope for this network. Send it exactly as the client produced it — do not re-encode it.",
  invalid_exact_stellar_payload_wrong_operation:
    "The transaction must contain exactly one InvokeHostFunction operation; it contained something else.",
  invalid_exact_stellar_payload_wrong_function_name:
    "The invoked contract function is not 'transfer'. The 'exact' scheme settles through a SEP-41 'transfer' call.",
  invalid_exact_stellar_payload_unsafe_tx_or_op_source:
    "The transaction or operation source account is not the payer. The facilitator will not sign a transaction whose source it does not expect.",
  invalid_exact_stellar_payload_has_subinvocations:
    "The authorization entry contains sub-invocations. The 'exact' scheme allows a single, unnested token transfer so the authorization cannot trigger anything else.",

  // ── Payment terms ──────────────────────────────────────────────────────────
  invalid_exact_stellar_payload_wrong_asset:
    "The token contract in the signed transaction is not the asset named in the payment requirements.",
  invalid_exact_stellar_payload_wrong_amount:
    "The amount in the signed transaction does not equal the amount in the payment requirements. The 'exact' scheme requires an exact match.",
  invalid_exact_stellar_payload_wrong_recipient:
    "The recipient in the signed transaction is not the 'payTo' address in the payment requirements.",

  // ── Authorization entries ──────────────────────────────────────────────────
  invalid_exact_stellar_payload_no_auth_entries:
    "The transaction carries no Soroban authorization entries, so nobody authorized the transfer.",
  invalid_exact_stellar_payload_missing_payer_signature:
    "The payer has not signed the authorization entry for this transfer.",
  invalid_exact_stellar_payload_unexpected_pending_signatures:
    "The transaction still needs signatures from accounts other than the payer. This facilitator settles single-signer payments only.",
  invalid_exact_stellar_payload_unsupported_credential_type:
    "The authorization entry uses a credential type the 'exact' scheme does not support.",
  [LEDGER_SKEW_REASON]:
    "The authorization entry's signature expiration ledger is too far in the future. This is usually Soroban RPC ledger-height skew rather than a bad payment (see x402-foundation/x402#3168); the facilitator already retried. Re-signing with a freshly read ledger height will succeed.",

  // ── Facilitator safety ─────────────────────────────────────────────────────
  invalid_exact_stellar_payload_facilitator_in_auth:
    "A facilitator-controlled account appears in the transaction's authorization entries. The facilitator refuses to authorize movements of its own funds on a payer's behalf.",
  invalid_exact_stellar_payload_facilitator_is_payer:
    "The payer is a facilitator-controlled account. The facilitator will not pay itself.",
  invalid_exact_stellar_payload_fee_exceeds_maximum:
    "The simulated network fee for this payment exceeds this facilitator's configured ceiling (MAX_TRANSACTION_FEE_STROOPS), so it declined to sponsor the transaction.",

  // ── Simulation ─────────────────────────────────────────────────────────────
  invalid_exact_stellar_payload_simulation_failed:
    "Simulating the transfer against Soroban RPC failed. The usual cause is an insufficient balance of the payment asset in the payer's account, or a missing trustline.",
  invalid_exact_stellar_payload_no_transfer_events:
    "Simulation produced no token transfer event, so the transaction would not actually move the payment.",
  invalid_exact_stellar_payload_multiple_transfers:
    "Simulation produced more than one token transfer event. The 'exact' scheme permits exactly one.",
  invalid_exact_stellar_payload_event_not_transfer:
    "The contract event emitted by the simulation is not a 'transfer' event.",
  invalid_exact_stellar_payload_event_missing_contract_id:
    "The simulated transfer event carries no contract id, so the asset being moved cannot be confirmed.",
  invalid_exact_stellar_payload_event_wrong_asset:
    "The simulated transfer moves a different token contract than the payment requirements specify.",
  invalid_exact_stellar_payload_event_wrong_amount:
    "The simulated transfer moves a different amount than the payment requirements specify.",
  invalid_exact_stellar_payload_event_wrong_from:
    "The simulated transfer debits an account other than the payer that signed the authorization.",
  invalid_exact_stellar_payload_event_wrong_to:
    "The simulated transfer credits an account other than the 'payTo' address in the payment requirements.",

  // ── Settlement (@x402/stellar, exact) ──────────────────────────────────────
  settle_exact_stellar_signer_selection_failed:
    "The facilitator could not select a signing account for this settlement. Its signer pool may be exhausted or unfunded.",
  settle_exact_stellar_transaction_signing_failed:
    "The facilitator failed to sign the settlement transaction. Nothing was submitted and no funds moved.",
  settle_exact_stellar_fee_bump_signing_failed:
    "The facilitator failed to sign the fee-bump wrapper for this settlement. Nothing was submitted and no funds moved.",
  settle_exact_stellar_transaction_submission_failed:
    "The settlement transaction could not be submitted to the network. Check the transaction hash on the ledger before retrying — submission may have partially completed.",
  settle_exact_stellar_transaction_failed:
    "The settlement transaction was submitted but the network rejected it. No payment was recorded.",
};

/**
 * Returns the sentence for a reason code.
 *
 * @param reason - A machine-readable reason code
 * @returns The mapped explanation, or a truthful fallback for an unmapped code
 */
export function describeReason(reason: string): string {
  return (
    REASON_MESSAGES[reason] ??
    `The facilitator rejected this request with reason '${reason}', which it has no description for. This is a gap in the facilitator's reason table, not a fault in your request; please report it.`
  );
}

/**
 * Maps a thrown error to a reason code.
 *
 * @param error - Anything thrown out of the facilitator or the x402 packages
 * @returns The reason code that best describes it
 */
export function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  if (/no scheme registered|unsupported|not registered/.test(lowered)) {
    return LOCAL_REASONS.UNSUPPORTED_SCHEME_OR_NETWORK;
  }
  if (/econnrefused|enotfound|etimedout|fetch failed|socket hang up|network error|rpc/.test(lowered)) {
    return LOCAL_REASONS.UPSTREAM_RPC_UNAVAILABLE;
  }
  return LOCAL_REASONS.FACILITATOR_INTERNAL_ERROR;
}

/**
 * Extracts a short, safe detail string from a thrown error for the response.
 *
 * @param error - The thrown value
 * @returns A trimmed single-line description
 */
export function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}
