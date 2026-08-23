/**
 * Wire panel: every message the payment exchanged, decoded.
 * License: Apache-2.0
 *
 * "Inspectable" is easy to claim and easy to fake by pretty-printing a summary
 * the page wrote itself. Everything here is the recorded traffic from the run
 * in the Flow panel, plus one thing the visitor cannot see anywhere else: the
 * signed Stellar envelope, decoded down to the authorization entries.
 *
 * The authorization entries are the whole security argument of `exact` on
 * Stellar. They are what the facilitator checks the transfer against, and what
 * stops it redirecting a payment or paying itself.
 */

import { Address, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { copyButton, el, json, replace } from "../lib/dom.js";
import { getState } from "../lib/state.js";

/**
 * Decodes the signed envelope into something a person can read.
 *
 * @param envelope - Base64 transaction envelope
 * @param networkPassphrase - Passphrase for the network it was signed for
 * @returns A plain description of the transaction
 */
function decodeEnvelope(envelope: string, networkPassphrase: string): unknown {
  const transaction = TransactionBuilder.fromXDR(envelope, networkPassphrase) as any;

  const operations = (transaction.operations ?? []).map((operation: any) => {
    const base: Record<string, unknown> = { type: operation.type, source: operation.source };

    if (operation.type === "invokeHostFunction") {
      const fn = operation.func;
      if (fn?.switch?.().name === "hostFunctionTypeInvokeContract") {
        const invocation = fn.invokeContract();
        base.contract = scv(invocation.contractAddress());
        base.function = invocation.functionName().toString();
        base.args = invocation.args().map(scv);
      }
      base.authorizationEntries = (operation.auth ?? []).map((entry: any) => {
        const credentials = entry.credentials();
        const kind = credentials.switch().name;
        const root = entry.rootInvocation();
        const fnv = root.function();
        const described: Record<string, unknown> = {
          credentials:
            kind === "sorobanCredentialsAddress"
              ? {
                  type: "address",
                  address: scv(credentials.address().address()),
                  // The ledger past which this authorization is dead. The
                  // facilitator refuses anything reaching too far ahead.
                  signatureExpirationLedger: credentials.address().signatureExpirationLedger(),
                  nonce: credentials.address().nonce().toString(),
                }
              : { type: kind },
          // Anything nested here would be extra authority riding along with the
          // payment. The facilitator rejects a payload that has any.
          subInvocations: root.subInvocations().length,
        };
        if (fnv.switch().name === "sorobanAuthorizedFunctionTypeContractFn") {
          const call = fnv.contractFn();
          described.authorizes = {
            contract: scv(call.contractAddress()),
            function: call.functionName().toString(),
            args: call.args().map(scv),
          };
        }
        return described;
      });
    }
    return base;
  });

  return {
    source: transaction.source,
    fee: transaction.fee,
    sequence: transaction.sequence,
    signatures: transaction.signatures?.length ?? 0,
    operations,
  };
}

/**
 * Renders an ScVal as a readable value.
 *
 * Only the shapes an `exact` transfer actually uses are handled; anything else
 * falls back to naming its type rather than guessing.
 *
 * @param value - The ScVal, or an ScAddress
 * @returns A printable representation
 */
function scv(value: any): unknown {
  try {
    if (value instanceof xdr.ScAddress || typeof value.switch !== "function") {
      return addressToString(value);
    }
    const name = value.switch().name;
    switch (name) {
      case "scvAddress":
        return addressToString(value.address());
      case "scvI128": {
        const parts = value.i128();
        const hi = BigInt(parts.hi().toString());
        const lo = BigInt(parts.lo().toString());
        return ((hi << 64n) | lo).toString();
      }
      case "scvU32":
      case "scvI32":
        return value.value();
      case "scvU64":
      case "scvI64":
        return value.value().toString();
      case "scvString":
        return value.str().toString();
      case "scvSymbol":
        return value.sym().toString();
      case "scvBool":
        return value.b();
      default:
        return `<${name}>`;
    }
  } catch {
    return "<undecodable>";
  }
}

/**
 * Renders a Stellar address XDR value as a G… or C… string.
 *
 * @param address - The ScAddress
 * @returns The string form
 */
function addressToString(address: any): string {
  try {
    return Address.fromScAddress(address).toString();
  } catch {
    return "<address>";
  }
}

/**
 * Renders the Wire panel.
 *
 * @param host - Element to render into
 */
export function renderWire(host: HTMLElement): void {
  const { run, config } = getState();

  if (!run) {
    replace(
      host,
      el("div", { class: "panel-head" }, [
        el("h2", {}, ["The wire"]),
        el("p", { class: "lede" }, [
          "Every message a payment exchanges, decoded - including the signed Stellar envelope.",
        ]),
      ]),
      el("div", { class: "card card-empty" }, [
        el("p", {}, ["Nothing to show yet. Run a payment in the Flow panel and come back."]),
      ]),
    );
    return;
  }

  const passphrase = config.network.endsWith("pubnet")
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";

  let decoded: unknown;
  try {
    decoded = decodeEnvelope(run.paymentPayload.payload.transaction, passphrase);
  } catch (error) {
    decoded = { error: error instanceof Error ? error.message : String(error) };
  }

  replace(
    host,
    el("div", { class: "panel-head" }, [
      el("h2", {}, ["The wire"]),
      el("p", { class: "lede" }, [
        "The traffic from your last payment, as it happened. Nothing here is a summary written " +
          "for display - it is what was recorded while the messages went out.",
      ]),
    ]),

    section(
      "1. What the seller asked for",
      "The 402 response, base64-decoded from the PAYMENT-REQUIRED header. `accepts` is the list " +
        "of terms the seller will take; the client picks one and signs against it exactly.",
      json(run.challenge),
    ),

    section(
      "2. The terms that were signed",
      "One entry from `accepts`. The facilitator will check the signed transaction against every " +
        "field here - asset, amount, recipient - and refuse any mismatch.",
      json(run.terms),
    ),

    section(
      "3. The signed envelope, decoded",
      "This is the part no other view shows you. The authorization entry is what the payer " +
        "actually signed: a single `transfer` on one contract, with an expiry ledger and a nonce. " +
        "`subInvocations: 0` matters - anything nested there would be extra authority travelling " +
        "with the payment, and the facilitator rejects a payload that has any.",
      el("div", {}, [
        json(decoded),
        el("div", { class: "row" }, [
          copyButton(() => run.paymentPayload.payload.transaction, "Copy raw XDR"),
          el("span", { class: "muted small" }, [
            "Paste it into the Stellar Laboratory XDR viewer to decode it independently.",
          ]),
        ]),
      ]),
    ),

    section(
      "4. Verification, with nothing at stake",
      "POST /verify. The facilitator ran every check it would run at settlement and reported the " +
        "result without submitting anything. A buyer can always ask this first.",
      json(run.verifyResponse),
    ),

    section(
      "5. The settlement",
      "Returned by the seller in the PAYMENT-RESPONSE header after the facilitator submitted the " +
        "transaction. The hash is the same one Horizon confirmed in the Flow panel.",
      json(run.settleResponse),
    ),

    run.extensionResponses
      ? section(
          "6. What the catalog made of it",
          "EXTENSION-RESPONSES, base64. The Bazaar reports back whether the seller's listing was " +
            "accepted, and says why when it was not - the feedback loop the discovery spec asks for.",
          json(decodeExtensionResponses(run.extensionResponses)),
        )
      : undefined,
  );
}

/**
 * Decodes the base64 EXTENSION-RESPONSES header.
 *
 * @param value - The header value
 * @returns The decoded object, or the raw value when it does not decode
 */
function decodeExtensionResponses(value: string): unknown {
  try {
    return JSON.parse(atob(value));
  } catch {
    return { raw: value };
  }
}

/**
 * Builds a titled section.
 *
 * @param title - Section heading
 * @param note - Explanation shown under the heading
 * @param body - Section content
 * @returns The section element
 */
function section(title: string, note: string, body: Node): HTMLElement {
  return el("section", { class: "wire-section" }, [
    el("h3", {}, [title]),
    el("p", { class: "muted" }, [note]),
    body,
  ]);
}
