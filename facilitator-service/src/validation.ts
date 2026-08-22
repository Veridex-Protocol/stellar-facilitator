/**
 * Veridex Facilitator Service - Request Envelope Validation
 * License: Apache-2.0
 *
 * Deliberately shallow. This checks that a request is structurally an x402
 * verify/settle request and returns a sentence naming the field that is wrong.
 * It does not inspect, normalise, or re-encode the signed `transaction` — that
 * string is handed to `@x402/stellar` byte-for-byte as the client produced it.
 * A facilitator that "helpfully" reshapes a signed envelope breaks every stock
 * client, which is the one thing this service must not do.
 */

import { StrKey } from "@stellar/stellar-sdk";

/**
 * Checks a value is a plain object.
 *
 * @param value - Candidate
 * @returns Whether it is a non-null, non-array object
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the `paymentRequirements` half of a request.
 *
 * @param requirements - Candidate requirements
 * @returns A description of the problem, or null when valid
 */
export function validatePaymentRequirements(requirements: unknown): string | null {
  if (!isObject(requirements)) {
    return "'paymentRequirements' must be an object.";
  }
  const { scheme, network, asset, amount, payTo, maxTimeoutSeconds } = requirements;

  if (typeof scheme !== "string" || scheme.length === 0) {
    return "'paymentRequirements.scheme' must be a non-empty string; see GET /supported for the schemes this facilitator implements.";
  }
  if (typeof network !== "string" || !network.includes(":")) {
    return "'paymentRequirements.network' must be a CAIP-2 identifier such as 'stellar:testnet'.";
  }
  if (typeof asset !== "string" || !StrKey.isValidContract(asset)) {
    return "'paymentRequirements.asset' must be the SEP-41 token contract address (C...) being paid. Classic asset identifiers such as 'native' are not valid in x402 v2.";
  }
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
    return "'paymentRequirements.amount' must be a string of digits: the amount in the asset's atomic units.";
  }
  if (
    typeof payTo !== "string" ||
    !(StrKey.isValidEd25519PublicKey(payTo) || StrKey.isValidContract(payTo) || /^M[A-Z2-7]{68}$/.test(payTo))
  ) {
    return "'paymentRequirements.payTo' must be a Stellar address (G..., M... or C...) to receive the payment.";
  }
  if (typeof maxTimeoutSeconds !== "number" || !Number.isFinite(maxTimeoutSeconds)) {
    return "'paymentRequirements.maxTimeoutSeconds' must be a number.";
  }
  return null;
}

/**
 * Validates the `paymentPayload` half of a request.
 *
 * @param payload - Candidate payload
 * @returns A description of the problem, or null when valid
 */
export function validatePaymentPayload(payload: unknown): string | null {
  if (!isObject(payload)) {
    return "'paymentPayload' must be an object.";
  }
  if (typeof payload.x402Version !== "number") {
    return "'paymentPayload.x402Version' must be a number; this facilitator speaks x402 v2.";
  }
  if (!isObject(payload.accepted)) {
    return "'paymentPayload.accepted' must be the payment requirements object the client accepted.";
  }
  if (!isObject(payload.payload)) {
    return "'paymentPayload.payload' must be an object carrying the signed 'transaction'.";
  }
  const transaction = (payload.payload as Record<string, unknown>).transaction;
  if (typeof transaction !== "string" || transaction.length === 0) {
    return "'paymentPayload.payload.transaction' must be the base64-encoded signed Stellar transaction, exactly as the client produced it.";
  }
  return null;
}

/**
 * Validates a `POST /verify` or `POST /settle` request body.
 *
 * @param body - Parsed request body
 * @returns A description of the problem, or null when valid
 */
export function validateFacilitatorRequest(body: unknown): string | null {
  if (!isObject(body)) {
    return "Request body must be a JSON object carrying 'paymentPayload' and 'paymentRequirements'.";
  }
  return (
    validatePaymentPayload(body.paymentPayload) ??
    validatePaymentRequirements(body.paymentRequirements)
  );
}
