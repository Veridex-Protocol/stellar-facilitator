/**
 * Refusals panel: make the facilitator say no, and read why.
 * License: Apache-2.0
 *
 * A facilitator that accepts good payments is easy. The interesting property is
 * that it refuses bad ones *and explains itself* - every rejection carries a
 * stable machine-readable code and a sentence a person can act on. The
 * facilitator's own test suite asserts that table stays exhaustive against the
 * codes its pinned packages can emit.
 *
 * So this panel is a checklist rather than a game. Each attack below is a
 * genuinely malformed or dishonest payment, sent to /verify - which never
 * settles anything, so probing costs nothing. The code that comes back is
 * recorded. There is also a raw editor, because a canned list of attacks the
 * authors chose is not much of an invitation.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { el, json, pill, replace } from "../lib/dom.js";
import { getState, setState } from "../lib/state.js";
import { postFacilitator, signPayload } from "../lib/x402.js";

interface Attack {
  id: string;
  title: string;
  note: string;
  /** The code this is expected to elicit; shown as a hint, never as a pass condition. */
  expect: string;
  build: (context: BuildContext) => Promise<{ paymentPayload: unknown; paymentRequirements: unknown }>;
}

interface BuildContext {
  terms: any;
  genuinePayload: any;
  randomAddress: () => string;
}

const ATTACKS: Attack[] = [
  {
    id: "amount",
    title: "Claim the payment was for more than it was",
    note: "A genuine signed payment, presented against requirements demanding a larger amount. The signature is real; the terms do not match it.",
    expect: "invalid_exact_stellar_payload_wrong_amount",
    build: async ({ terms, genuinePayload }) => ({
      paymentPayload: genuinePayload,
      paymentRequirements: { ...terms, amount: String(BigInt(terms.amount) + 1n) },
    }),
  },
  {
    id: "recipient",
    title: "Redirect the payment to someone else",
    note: "The single most important thing a facilitator must refuse. The payer signed a transfer to one address; the requirements name another - a real, well-formed one, so the check that catches it is the facilitator's and not a syntax check.",
    expect: "invalid_exact_stellar_payload_wrong_recipient",
    build: async ({ terms, genuinePayload, randomAddress }) => ({
      paymentPayload: genuinePayload,
      paymentRequirements: { ...terms, payTo: randomAddress() },
    }),
  },
  {
    id: "asset",
    title: "Pay in a different asset",
    note: "Same signed transfer, but the requirements name another token contract.",
    expect: "invalid_exact_stellar_payload_wrong_asset",
    build: async ({ terms, genuinePayload }) => ({
      paymentPayload: genuinePayload,
      paymentRequirements: {
        ...terms,
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      },
    }),
  },
  {
    id: "classic-asset",
    title: "Use a classic asset identifier",
    note: "x402 v2 on Stellar settles SEP-41 token contracts. 'native' is a classic asset identifier and is not a contract address.",
    expect: "invalid_request_body",
    build: async ({ terms, genuinePayload }) => ({
      paymentPayload: genuinePayload,
      paymentRequirements: { ...terms, asset: "native" },
    }),
  },
  {
    id: "tampered-xdr",
    title: "Flip a byte in the signed envelope",
    note: "One character changed in the base64. It still decodes, but the authorization signature no longer covers what it decodes to, so simulation rejects it.",
    expect: "invalid_exact_stellar_payload_simulation_failed",
    build: async ({ terms, genuinePayload }) => {
      const original: string = genuinePayload.payload.transaction;
      const index = Math.floor(original.length / 2);
      const swapped = original[index] === "A" ? "B" : "A";
      return {
        paymentPayload: {
          ...genuinePayload,
          payload: {
            ...genuinePayload.payload,
            transaction: original.slice(0, index) + swapped + original.slice(index + 1),
          },
        },
        paymentRequirements: terms,
      };
    },
  },
  {
    id: "not-xdr",
    title: "Send something that is not a transaction at all",
    note: "The transaction field is a string, so it is well-typed nonsense. It should be refused with an explanation, not a stack trace.",
    expect: "invalid_exact_stellar_payload_malformed",
    build: async ({ terms }) => ({
      paymentPayload: { x402Version: 2, accepted: terms, payload: { transaction: "NOT_XDR" } },
      paymentRequirements: terms,
    }),
  },
  {
    id: "empty",
    title: "Send an empty request body",
    note: "The least effort possible. The answer should still name the missing field rather than returning a 500.",
    expect: "invalid_request_body",
    build: async () => ({ paymentPayload: undefined, paymentRequirements: undefined }),
  },
  {
    id: "wrong-network",
    title: "Ask for a network this facilitator does not serve",
    note: "A facilitator should serve only what it advertises on /supported, and say so plainly when asked for anything else.",
    expect: "network_mismatch",
    build: async ({ terms, genuinePayload }) => ({
      paymentPayload: genuinePayload,
      paymentRequirements: { ...terms, network: "eip155:1" },
    }),
  },
  {
    id: "wrong-scheme",
    title: "Ask for a scheme this facilitator does not implement",
    note: "Naming a scheme that is absent from /supported must be refused, not attempted.",
    expect: "unsupported_scheme",
    build: async ({ terms, genuinePayload }) => ({
      paymentPayload: genuinePayload,
      paymentRequirements: { ...terms, scheme: "not-a-real-scheme" },
    }),
  },
];

/**
 * Renders the Refusals panel.
 *
 * @param host - Element to render into
 */
export function renderRefusals(host: HTMLElement): void {
  const { run, config, wallet } = getState();

  const head = el("div", { class: "panel-head" }, [
    el("h2", {}, ["Try to get a bad payment through"]),
    el("p", { class: "lede" }, [
      "Every attack below goes to POST /verify, which checks a payment without settling it - so " +
        "none of this costs anything and none of it moves money. What comes back is a stable " +
        "reason code and a sentence explaining it. Collect the codes.",
    ]),
  ]);

  if (!run || !wallet) {
    replace(
      host,
      head,
      el("div", { class: "card card-empty" }, [
        el("p", {}, [
          "Run a payment in the Flow panel first. These attacks are built by taking that genuine " +
            "signed payment apart, so there has to be one.",
        ]),
      ]),
    );
    return;
  }

  const tally = el("div", { class: "tally" });
  const list = el("div", { class: "attacks" });
  const custom = el("div");

  /**
   * Redraws the collected-codes tally.
   */
  function drawTally(): void {
    const elicited = getState().elicited;
    replace(
      tally,
      el("div", { class: "card" }, [
        el("div", { class: "card-head" }, [
          el("h3", {}, ["Reason codes you have elicited"]),
          pill(elicited.size > 0 ? "ok" : "idle", String(elicited.size)),
        ]),
        elicited.size === 0
          ? el("p", { class: "muted" }, ["None yet. Run an attack below."])
          : el(
              "div",
              { class: "row wrap" },
              [...elicited].sort().map((code) => el("code", { class: "inline" }, [code])),
            ),
      ]),
    );
  }

  /**
   * Runs one attack and renders its outcome.
   *
   * @param attack - The attack to run
   * @param output - Where to render the result
   */
  async function run1(attack: Attack, output: HTMLElement): Promise<void> {
    replace(output, el("p", { class: "muted small" }, ["Asking…"]));
    try {
      const built = await attack.build({
        terms: run!.terms,
        genuinePayload: run!.paymentPayload,
        // A well-formed address nobody controls. A malformed one would be
        // caught by envelope validation first, and the attack would prove
        // nothing about whether the facilitator checks the recipient.
        randomAddress: () => Keypair.random().publicKey(),
      });

      const { status, body } = await postFacilitator(config, "/verify", {
        paymentPayload: built.paymentPayload,
        paymentRequirements: built.paymentRequirements,
      });

      const accepted = body.isValid === true;
      const code = body.invalidReason ?? (accepted ? "(accepted)" : "(no reason given)");

      if (!accepted && body.invalidReason) {
        const elicited = new Set(getState().elicited);
        elicited.add(body.invalidReason);
        setState({ elicited });
        drawTally();
      }

      replace(
        output,
        el("div", { class: accepted ? "card card-error" : "card card-success" }, [
          el("div", { class: "card-head" }, [
            el("h4", {}, [accepted ? "It was accepted" : "Refused"]),
            pill(accepted ? "fail" : "ok", `HTTP ${status}`),
          ]),
          accepted
            ? el("p", {}, [
                "This payment should not have verified. That is a finding - please report it in " +
                  "the channel with the details below.",
              ])
            : el("div", {}, [
                el("div", { class: "reason-code" }, [el("code", { class: "inline" }, [code])]),
                el("p", { class: "small" }, [body.invalidMessage ?? "(no message)"]),
                code !== attack.expect
                  ? el("p", { class: "muted small" }, [
                      `Expected ${attack.expect}. A different code is not necessarily wrong - ` +
                        "several checks can catch the same forgery, and whichever runs first wins.",
                    ])
                  : undefined,
              ]),
          json(body, "Full response"),
        ]),
      );
    } catch (error) {
      replace(
        output,
        el("div", { class: "card card-error" }, [
          el("p", {}, [error instanceof Error ? error.message : String(error)]),
        ]),
      );
    }
  }

  replace(
    list,
    ...ATTACKS.map((attack) => {
      const output = el("div", { class: "attack-output" });
      return el("div", { class: "attack" }, [
        el("div", { class: "attack-head" }, [
          el("div", {}, [
            el("div", { class: "attack-title" }, [attack.title]),
            el("div", { class: "muted small" }, [attack.note]),
          ]),
          el(
            "button",
            { class: "btn btn-ghost btn-sm", type: "button", onclick: () => void run1(attack, output) },
            ["Try it"],
          ),
        ]),
        output,
      ]);
    }),
  );

  // A list of attacks chosen by the authors is not much of an invitation, so
  // the raw editor sends whatever the visitor writes.
  const editor = el("textarea", {
    class: "editor",
    rows: 14,
    spellcheck: false,
  }) as HTMLTextAreaElement;
  editor.value = JSON.stringify(
    { paymentPayload: run.paymentPayload, paymentRequirements: run.terms },
    null,
    2,
  );
  const customOutput = el("div");

  replace(
    custom,
    el("section", { class: "wire-section" }, [
      el("h3", {}, ["Or write your own"]),
      el("p", { class: "muted" }, [
        "The exact body that goes to POST /verify, pre-filled with the payment that worked. " +
          "Change anything. If you get something through that should not have gone through, that " +
          "is worth reporting.",
      ]),
      editor,
      el("div", { class: "row" }, [
        el(
          "button",
          {
            class: "btn btn-primary btn-sm",
            type: "button",
            onclick: async () => {
              replace(customOutput, el("p", { class: "muted small" }, ["Asking…"]));
              let parsed: unknown;
              try {
                parsed = JSON.parse(editor.value);
              } catch (error) {
                replace(
                  customOutput,
                  el("div", { class: "card card-error" }, [
                    el("p", {}, [`That is not valid JSON: ${(error as Error).message}`]),
                  ]),
                );
                return;
              }
              try {
                const { status, body } = await postFacilitator(config, "/verify", parsed);
                if (body?.invalidReason) {
                  const elicited = new Set(getState().elicited);
                  elicited.add(body.invalidReason);
                  setState({ elicited });
                  drawTally();
                }
                replace(
                  customOutput,
                  el("div", { class: body?.isValid ? "card card-error" : "card card-success" }, [
                    el("div", { class: "card-head" }, [
                      el("h4", {}, [body?.isValid ? "Accepted" : "Refused"]),
                      pill(body?.isValid ? "fail" : "ok", `HTTP ${status}`),
                    ]),
                    json(body),
                  ]),
                );
              } catch (error) {
                replace(
                  customOutput,
                  el("div", { class: "card card-error" }, [
                    el("p", {}, [error instanceof Error ? error.message : String(error)]),
                  ]),
                );
              }
            },
          },
          ["Send to /verify"],
        ),
        el(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            type: "button",
            onclick: () => {
              editor.value = JSON.stringify(
                { paymentPayload: getState().run!.paymentPayload, paymentRequirements: getState().run!.terms },
                null,
                2,
              );
            },
          },
          ["Reset"],
        ),
      ]),
      customOutput,
    ]),
  );

  replace(host, head, tally, list, custom);
  drawTally();
}
