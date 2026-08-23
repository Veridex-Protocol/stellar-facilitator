/**
 * Receipt panel: check the facilitator's signature yourself.
 * License: Apache-2.0
 *
 * The facilitator signs an `x402job/1` receipt for every direct settlement and
 * claims anyone can recompute it. This panel is that claim, executed in front
 * of the visitor: canonicalize the claims with our own RFC 8785 implementation,
 * hash with the browser's WebCrypto, check the Ed25519 signature against the
 * key the facilitator publishes on /supported.
 *
 * Then it offers to forge one. A signature scheme is only worth anything if
 * breaking it is something you are invited to try, so the tamper controls
 * rewrite a field of the settlement and re-run the same verification.
 */

import { copyButton, el, ellipsize, field, json, pill, replace } from "../lib/dom.js";
import { getState } from "../lib/state.js";
import { directSettle } from "../lib/x402.js";
import { tamper, verifyReceipt, type Receipt } from "../lib/verify.js";

/**
 * Renders the Receipt panel.
 *
 * @param host - Element to render into
 */
export function renderReceipt(host: HTMLElement): void {
  const { run, config, wallet } = getState();

  const head = el("div", { class: "panel-head" }, [
    el("h2", {}, ["Verify the receipt"]),
    el("p", { class: "lede" }, [
      "The facilitator signs a statement of what it settled. Everything below is computed in " +
        "this browser, by this page's own canonicalization - not by the service that produced it. " +
        "Verifying a signature with the code that made it proves only that the code agrees with itself.",
    ]),
  ]);

  if (!run || !wallet) {
    replace(
      host,
      head,
      el("div", { class: "card card-empty" }, [
        el("p", {}, ["Run a payment in the Flow panel first."]),
      ]),
    );
    return;
  }

  const body = el("div");
  const action = el("div", { class: "row" }, [
    el(
      "button",
      { class: "btn btn-primary", type: "button", onclick: () => void fetchReceipt() },
      ["Settle once more and fetch the receipt"],
    ),
    el("span", { class: "muted small" }, [
      "The seller-mediated payment returns its settlement in a header, which carries the " +
        "transaction but not the signed receipt. Asking the facilitator to settle directly returns " +
        "the whole body. This settles a second real payment.",
    ]),
  ]);

  replace(host, head, action, body);

  /**
   * Settles directly and renders the verification.
   */
  async function fetchReceipt(): Promise<void> {
    replace(body, el("div", { class: "card" }, [el("p", { class: "muted" }, ["Settling…"])]));

    try {
      const echo = { resource: run!.challenge.resource, extensions: run!.challenge.extensions };
      const settled = await directSettle(config, wallet!, run!.terms, echo);
      const receipt: Receipt | undefined = settled.settleResponse.receipt;

      if (!receipt) {
        replace(
          body,
          el("div", { class: "card card-error" }, [
            el("h3", {}, ["No receipt was issued"]),
            el("p", {}, [
              "The settlement succeeded but carried no receipt. The facilitator declines to issue " +
                "one when it cannot name the payer truthfully, which is the correct behaviour - a " +
                "receipt asserting the wrong payer is worse than no receipt.",
            ]),
            json(settled.settleResponse, "Settle response"),
          ]),
        );
        return;
      }

      const signers: string[] = run!.supported?.signers?.["stellar:*"] ?? [];
      const result = await verifyReceipt(receipt, signers, settled.settleResponse.transaction);

      replace(
        body,
        el("div", { class: `card ${result.verified ? "card-success" : "card-error"}` }, [
          el("div", { class: "card-head" }, [
            el("h3", {}, [result.verified ? "This receipt holds up" : "This receipt does not verify"]),
            pill(result.verified ? "ok" : "fail", `${result.steps.filter((s) => s.passed).length}/${result.steps.length} checks`),
          ]),
          el(
            "ul",
            { class: "checks" },
            result.steps.map((step) =>
              el("li", { class: step.passed ? "check-ok" : "check-fail" }, [
                el("span", { class: "check-mark" }, [step.passed ? "✓" : "✕"]),
                el("div", {}, [
                  el("div", { class: "check-label" }, [step.label]),
                  el("div", { class: "muted small" }, [step.detail]),
                ]),
              ]),
            ),
          ),
        ]),

        el("section", { class: "wire-section" }, [
          el("h3", {}, ["The signed bytes"]),
          el("p", { class: "muted" }, [
            "RFC 8785 canonical JSON: object keys sorted, no insignificant whitespace, one " +
              "unambiguous encoding per value. This is the exact byte string the signature covers, " +
              "produced here rather than taken from the response.",
          ]),
          el("pre", { class: "code code-wrap" }, [result.canonical]),
          el("div", { class: "row" }, [
            copyButton(() => result.canonical, "Copy canonical claims"),
            copyButton(() => receipt.signature, "Copy signature"),
          ]),
        ]),

        el("section", { class: "wire-section" }, [
          el("h3", {}, ["Now try to forge it"]),
          el("p", { class: "muted" }, [
            "Rewrite one field of the settlement and the signature is checked again, unchanged. " +
              "This is not a hypothetical: an earlier version of this facilitator canonicalized the " +
              "nested settlement object as `{}`, so every field inside it could be rewritten with " +
              "the signature still verifying. That receipt proved nothing about the payment it " +
              "described. Try each field.",
          ]),
          tamperControls(receipt),
        ]),

        json(receipt.claims, "The claims in full"),
      );
    } catch (error) {
      replace(
        body,
        el("div", { class: "card card-error" }, [
          el("h3", {}, ["Could not settle"]),
          el("p", {}, [error instanceof Error ? error.message : String(error)]),
        ]),
      );
    }
  }
}

/**
 * Builds the tamper controls for a receipt.
 *
 * @param receipt - The genuine receipt
 * @returns The controls
 */
function tamperControls(receipt: Receipt): HTMLElement {
  const output = el("div", { class: "tamper-output" });
  const fields: Array<keyof Receipt["claims"]["settlement"]> = [
    "tx",
    "amount",
    "payer",
    "asset",
    "network",
  ];

  const buttons = fields.map((name) =>
    el(
      "button",
      {
        class: "btn btn-ghost btn-sm",
        type: "button",
        onclick: () => {
          const forged = tamper(receipt, name, "TAMPERED");
          replace(
            output,
            el("div", { class: forged.stillVerifies ? "card card-error" : "card card-success" }, [
              el("div", { class: "card-head" }, [
                el("h4", {}, [`settlement.${name} rewritten to "TAMPERED"`]),
                pill(forged.stillVerifies ? "fail" : "ok", forged.stillVerifies ? "signature survived" : "signature broke"),
              ]),
              el("p", { class: "small" }, [
                forged.stillVerifies
                  ? "The signature still verifies over the forged claims. That is a real defect: the " +
                    "field is not covered by the signature and can be rewritten freely."
                  : "The signature no longer verifies. The field is covered, so it cannot be changed " +
                    "without invalidating the receipt - which is what a receipt is for.",
              ]),
              el("pre", { class: "code code-wrap" }, [forged.canonical]),
            ]),
          );
        },
      },
      [`Rewrite settlement.${name}`],
    ),
  );

  return el("div", {}, [el("div", { class: "row wrap" }, buttons), output]);
}
