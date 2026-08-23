/**
 * Flow panel: one real payment, step by step.
 * License: Apache-2.0
 *
 * This is the panel that has to work in thirty seconds. A visitor arrives with
 * no wallet, no keys and no patience; by the time they have read the heading
 * they should have a funded testnet account, and one click later a settled
 * payment with a link to it on a public block explorer.
 */

import { copyButton, el, ellipsize, field, json, pill, replace } from "../lib/dom.js";
import { getState, setState } from "../lib/state.js";
import { Trace, type Step } from "../lib/trace.js";
import {
  createWallet,
  existingWallet,
  forgetWallet,
  fundFromFriendbot,
  nativeBalance,
  waitForRpcVisibility,
} from "../lib/wallet.js";
import { runPayment } from "../lib/x402.js";

/**
 * Renders one step row.
 *
 * @param step - The step to render
 * @returns The row element
 */
function stepRow(step: Step): HTMLElement {
  const marks: Record<Step["state"], string> = {
    pending: "·",
    running: "→",
    ok: "✓",
    failed: "✕",
    skipped: "–",
  };

  const detail = el("div", { class: "step-detail" });
  if (step.summary) detail.append(el("div", { class: "step-summary" }, [step.summary]));
  if (step.error) detail.append(el("div", { class: "step-error" }, [step.error]));

  return el("div", { class: `step step-${step.state}` }, [
    el("span", { class: "step-mark" }, [marks[step.state]]),
    el("div", { class: "step-body" }, [
      el("div", { class: "step-title" }, [
        step.title,
        step.ms !== undefined ? el("span", { class: "step-ms" }, [`${step.ms} ms`]) : undefined,
      ]),
      el("div", { class: "step-note" }, [step.note]),
      detail,
    ]),
  ]);
}

/**
 * Renders the Flow panel.
 *
 * @param host - Element to render into
 */
export function renderFlow(host: HTMLElement): void {
  const { config } = getState();

  const walletBox = el("div", { class: "card" });
  const stepsBox = el("div", { class: "steps" });
  const resultBox = el("div");
  const actionBox = el("div", { class: "row" });

  let busy = false;

  /**
   * Redraws the wallet card from current state.
   */
  async function drawWallet(): Promise<void> {
    const wallet = getState().wallet;
    if (!wallet) {
      replace(
        walletBox,
        el("div", { class: "card-head" }, [
          el("h3", {}, ["No wallet yet"]),
          pill("idle", "not created"),
        ]),
        el("p", { class: "muted" }, [
          "A keypair will be generated in this tab and funded by Friendbot. It is created here, " +
            "stays here, and is discarded when you close the tab - the playground server never sees it.",
        ]),
      );
      return;
    }

    replace(
      walletBox,
      el("div", { class: "card-head" }, [
        el("h3", {}, ["Your testnet wallet"]),
        pill("ok", "in this tab only"),
      ]),
      field("Address", el("code", { class: "inline" }, [wallet.address])),
      field(
        "Balance",
        el("span", { id: "balance", class: "mono" }, ["reading…"]),
      ),
      el("p", { class: "muted small" }, [
        "Testnet funds with no value. The secret key lives in this tab's sessionStorage and is " +
          "never transmitted. Do not reuse this address for anything real.",
      ]),
      el("div", { class: "row" }, [
        copyButton(wallet.address, "Copy address"),
        el(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            type: "button",
            onclick: () => {
              forgetWallet();
              setState({ wallet: undefined, run: undefined });
              void drawWallet();
              replace(stepsBox);
              replace(resultBox);
              drawActions();
            },
          },
          ["Forget this wallet"],
        ),
      ]),
    );

    const balance = await nativeBalance(config, wallet.address);
    const target = walletBox.querySelector("#balance");
    if (target) target.textContent = balance ? `${balance} XLM` : "account not funded yet";
  }

  /**
   * Redraws the action buttons for the current state.
   */
  function drawActions(): void {
    const wallet = getState().wallet;
    replace(
      actionBox,
      el(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          disabled: busy,
          onclick: () => void start(),
        },
        [busy ? "Working…" : wallet ? "Pay again" : "Create a wallet and pay"],
      ),
      el("span", { class: "muted small" }, [
        wallet
          ? "Settles another real payment on Stellar testnet."
          : "Funds an account, then settles a real payment on Stellar testnet.",
      ]),
    );
  }

  /**
   * Creates and funds a wallet if needed, then runs a payment.
   */
  async function start(): Promise<void> {
    busy = true;
    drawActions();
    replace(resultBox);

    const trace = new Trace();
    trace.onChange((current) => {
      replace(stepsBox, ...current.steps.map(stepRow));
    });

    try {
      let wallet = getState().wallet;

      if (!wallet) {
        // Onboarding is its own short trace, so a slow testnet looks like
        // progress rather than a hung button.
        const onboarding = new Trace();
        onboarding.onChange((current) => replace(stepsBox, ...current.steps.map(stepRow)));
        onboarding.plan([
          {
            id: "keys",
            title: "Generate a keypair in this browser",
            note: "Ed25519, by @stellar/stellar-sdk. Nothing is sent anywhere.",
          },
          {
            id: "fund",
            title: "Ask Friendbot to create and fund the account",
            note: "The Stellar testnet faucet. This is what makes the playground zero-setup.",
          },
          {
            id: "visible",
            title: "Wait for Soroban RPC to catch up",
            note: "RPC lags Horizon and is load-balanced across nodes at different heights. Paying too early fails for no good reason.",
          },
        ]);

        wallet = await onboarding.run("keys", async (record) => {
          const created = createWallet();
          record({ summary: created.address });
          return created;
        });
        setState({ wallet });
        void drawWallet();

        await onboarding.run("fund", async (record) => {
          await fundFromFriendbot(config, wallet!.address);
          record({ summary: "funded with testnet XLM" });
        });

        await onboarding.run("visible", async (record) => {
          await waitForRpcVisibility(config, wallet!.address, (streak, required) =>
            record({ summary: `${streak}/${required} consecutive reads` }),
          );
          record({ summary: "visible from every RPC node we asked" });
        });

        void drawWallet();
      }

      const run = await runPayment(config, wallet, trace);
      setState({ run });
      void drawWallet();

      replace(
        resultBox,
        el("div", { class: "card card-success" }, [
          el("div", { class: "card-head" }, [
            el("h3", {}, ["Settled on Stellar testnet"]),
            pill("ok", "confirmed on Horizon"),
          ]),
          field(
            "Transaction",
            el("a", {
              class: "mono",
              href: `${config.explorerTxUrl}/${run.transaction}`,
              target: "_blank",
              rel: "noreferrer noopener",
            }, [ellipsize(run.transaction, 18, 10)]),
          ),
          field("Paid by", el("code", { class: "inline" }, [run.settleResponse.payer ?? "—"])),
          field("Amount", `${run.terms.amount} atomic units`),
          el("p", { class: "muted small" }, [
            "Open the explorer link in a new tab. Nothing on this page had to be trusted for that " +
              "transaction to exist - it is on the public ledger.",
          ]),
          json(run.resourceBody, "What you bought"),
          el("p", { class: "muted small" }, [
            "The Wire panel has every message this exchange sent. The Receipt panel can prove the " +
              "facilitator signed for it.",
          ]),
        ]),
      );
    } catch (error) {
      replace(
        resultBox,
        el("div", { class: "card card-error" }, [
          el("div", { class: "card-head" }, [
            el("h3", {}, ["The run stopped"]),
            pill("fail", "not settled"),
          ]),
          el("p", {}, [error instanceof Error ? error.message : String(error)]),
          el("p", { class: "muted small" }, [
            "The step list above shows exactly where it stopped. A refusal here is the facilitator " +
              "doing its job; a timeout is usually testnet RPC lagging, and retrying works.",
          ]),
        ]),
      );
    } finally {
      busy = false;
      drawActions();
    }
  }

  replace(
    host,
    el("div", { class: "panel-head" }, [
      el("h2", {}, ["Make a real payment"]),
      el("p", { class: "lede" }, [
        "One click funds an account and buys a resource for real money on Stellar testnet. " +
          "Every step below is a message that actually went over the wire, and the transaction " +
          "at the end is on a public ledger you can check without us.",
      ]),
    ]),
    walletBox,
    actionBox,
    stepsBox,
    resultBox,
  );

  const found = existingWallet();
  if (found) setState({ wallet: found });
  void drawWallet();
  drawActions();
}
