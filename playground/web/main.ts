/**
 * Veridex x402 Playground.
 * License: Apache-2.0
 *
 * A sandbox that makes real payments on Stellar testnet and then hands you
 * everything you need to check them without trusting this page: the wire
 * traffic, a signed receipt you can verify in your own browser, and a link to
 * the transaction on a public explorer.
 *
 * The buyer's keypair is generated here and never transmitted. The server that
 * serves this file holds no keys and custodies no funds.
 */

import { el, replace } from "./lib/dom.js";
import { loadConfig } from "./lib/config.js";
import { getState, initState, subscribe } from "./lib/state.js";
import { renderEvidence } from "./panels/evidence.js";
import { renderFlow } from "./panels/flow.js";
import { renderReceipt } from "./panels/receipt.js";
import { renderRefusals } from "./panels/refusals.js";
import { renderWire } from "./panels/wire.js";

interface Panel {
  id: string;
  label: string;
  blurb: string;
  render: (host: HTMLElement) => void | Promise<void>;
}

const PANELS: Panel[] = [
  { id: "flow", label: "Flow", blurb: "Pay for something, for real", render: renderFlow },
  { id: "wire", label: "Wire", blurb: "Every message, decoded", render: renderWire },
  { id: "receipt", label: "Receipt", blurb: "Check the signature yourself", render: renderReceipt },
  { id: "refusals", label: "Refusals", blurb: "Try to get a bad payment through", render: renderRefusals },
  { id: "evidence", label: "Evidence", blurb: "The CI conformance run", render: renderEvidence },
];

/**
 * Reads the panel id from the URL fragment.
 *
 * @returns The current panel id
 */
function currentPanelId(): string {
  const id = location.hash.replace(/^#\/?/, "");
  return PANELS.some((panel) => panel.id === id) ? id : "flow";
}

/**
 * Boots the playground.
 */
async function main(): Promise<void> {
  const root = document.querySelector("#root");
  if (!root) throw new Error("#root is missing from the document");

  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    replace(
      root,
      el("main", { class: "shell" }, [
        el("div", { class: "card card-error" }, [
          el("h3", {}, ["The playground could not load its configuration"]),
          el("p", {}, [error instanceof Error ? error.message : String(error)]),
        ]),
      ]),
    );
    return;
  }

  initState(config);

  const nav = el("nav", { class: "nav" });
  const view = el("section", { class: "view" });

  /**
   * Renders the navigation, marking the active panel.
   */
  function drawNav(): void {
    const active = currentPanelId();
    const hasRun = Boolean(getState().run);
    replace(
      nav,
      ...PANELS.map((panel) =>
        el(
          "a",
          {
            class: `nav-item ${panel.id === active ? "nav-active" : ""}`,
            href: `#/${panel.id}`,
          },
          [
            el("span", { class: "nav-label" }, [panel.label]),
            el("span", { class: "nav-blurb" }, [panel.blurb]),
            // A quiet nudge rather than a disabled link: the panels still
            // render, they just explain that they need a run first.
            panel.id !== "flow" && panel.id !== "evidence" && !hasRun
              ? el("span", { class: "nav-need" }, ["needs a payment"])
              : undefined,
          ],
        ),
      ),
    );
  }

  /**
   * Renders the panel named in the URL.
   */
  async function drawView(): Promise<void> {
    const panel = PANELS.find((entry) => entry.id === currentPanelId())!;
    replace(view);
    await panel.render(view);
    drawNav();
  }

  replace(
    root,
    el("header", { class: "masthead" }, [
      el("div", { class: "masthead-inner" }, [
        el("div", {}, [
          el("div", { class: "wordmark" }, ["Veridex x402 Playground"]),
          el("div", { class: "tagline" }, [
            "Real payments on Stellar testnet, and the evidence to check them yourself",
          ]),
        ]),
        el("div", { class: "masthead-meta" }, [
          el("span", { class: "net" }, [config.network]),
          el("span", { class: "muted small" }, ["testnet funds, no value"]),
        ]),
      ]),
    ]),
    el("main", { class: "shell" }, [
      el("aside", { class: "sidebar" }, [
        nav,
        el("div", { class: "sidebar-note" }, [
          el("h4", {}, ["Where the keys are"]),
          el("p", {}, [
            "Your keypair is generated in this tab, funded by Friendbot, and discarded when you " +
              "close it. It is never sent to the playground server, which holds no keys and no funds.",
          ]),
        ]),
        el("div", { class: "sidebar-note" }, [
          el("h4", {}, ["Not built yet"]),
          el("p", {}, [
            "Bazaar search and the metered ",
            el("code", { class: "inline" }, ["upto"]),
            " flow are not in this playground. The catalog and the settlement contract both exist " +
              "in the repository - they are not wired in here, and saying so beats a panel that " +
              "pretends otherwise.",
          ]),
        ]),
      ]),
      view,
    ]),
    el("footer", { class: "foot" }, [
      el("span", {}, ["Apache-2.0"]),
      el("span", { class: "muted" }, [
        `facilitator ${config.facilitatorUrl} · seller ${config.demoServerUrl}`,
      ]),
    ]),
  );

  window.addEventListener("hashchange", () => void drawView());
  subscribe(() => drawNav());
  await drawView();
}

void main().catch((error) => {
  const root = document.querySelector("#root");
  if (root) {
    replace(
      root,
      el("main", { class: "shell" }, [
        el("div", { class: "card card-error" }, [
          el("h3", {}, ["The playground failed to start"]),
          el("p", {}, [error instanceof Error ? error.message : String(error)]),
        ]),
      ]),
    );
  }
});
