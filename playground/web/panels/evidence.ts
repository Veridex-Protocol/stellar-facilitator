/**
 * Evidence panel: the conformance run, rendered.
 * License: Apache-2.0
 *
 * The facilitator's strongest claim is not made by this playground. It is made
 * by a harness that imports nothing from the repository, installs the stock
 * x402 client from public npm at pinned versions, and pays for a real resource
 * on Stellar testnet - in CI, on every push, with no secrets, so anyone can
 * fork it and get the same run.
 *
 * This panel serves that report verbatim rather than summarizing it, so what
 * the page shows and what CI produced cannot drift apart. Every transaction it
 * names links to a public explorer.
 */

import { el, ellipsize, field, json, pill, replace } from "../lib/dom.js";
import { getState } from "../lib/state.js";

interface Check {
  group: string;
  name: string;
  passed: boolean;
  error?: string;
  ms?: number;
}

interface Report {
  runAt: string;
  network: string;
  passed: number;
  failed: number;
  checks: Check[];
  settledTransaction?: string;
  uptoPartialTransaction?: string;
  uptoZeroTransaction?: string;
  uptoContract?: string;
  stockClientPackages?: Record<string, string>;
  buyer?: string;
  seller?: string;
  asset?: string;
  amount?: string;
}

/**
 * Renders the Evidence panel.
 *
 * @param host - Element to render into
 */
export async function renderEvidence(host: HTMLElement): Promise<void> {
  const { config } = getState();

  const head = el("div", { class: "panel-head" }, [
    el("h2", {}, ["The conformance run"]),
    el("p", { class: "lede" }, [
      "Not this playground's evidence - the repository's. A harness that imports nothing from " +
        "the codebase installs the stock x402 client from public npm and pays for real on Stellar " +
        "testnet. It runs in CI on every push, needs no secrets, and writes the report below.",
    ]),
  ]);

  replace(host, head, el("div", { class: "card" }, [el("p", { class: "muted" }, ["Loading…"])]));

  const response = await fetch("/api/conformance");
  const payload = await response.json();

  if (!payload.available) {
    replace(
      host,
      head,
      el("div", { class: "card card-empty" }, [
        el("h3", {}, ["No report on disk"]),
        el("p", {}, [payload.reason ?? "The conformance report has not been generated."]),
        el("p", { class: "muted small" }, [
          "Run `npm run conformance` at the repository root, or take the artifact from the latest CI run.",
        ]),
      ]),
    );
    return;
  }

  const report = payload.report as Report;
  const groups = new Map<string, Check[]>();
  for (const check of report.checks ?? []) {
    if (!groups.has(check.group)) groups.set(check.group, []);
    groups.get(check.group)!.push(check);
  }

  /**
   * Builds an explorer link for a transaction hash.
   *
   * @param hash - Transaction hash
   * @param label - What the transaction demonstrates
   * @returns The rendered row
   */
  const txRow = (hash: string | undefined, label: string) =>
    hash
      ? field(
          label,
          el(
            "a",
            {
              class: "mono",
              href: `${config.explorerTxUrl}/${hash}`,
              target: "_blank",
              rel: "noreferrer noopener",
            },
            [ellipsize(hash, 18, 10)],
          ),
        )
      : undefined;

  const allPassed = report.failed === 0;

  replace(
    host,
    head,

    el("div", { class: `card ${allPassed ? "card-success" : "card-error"}` }, [
      el("div", { class: "card-head" }, [
        el("h3", {}, [`${report.passed} passed, ${report.failed} failed`]),
        pill(allPassed ? "ok" : "fail", report.network),
      ]),
      field("Run at", new Date(report.runAt).toLocaleString()),
      report.stockClientPackages
        ? field(
            "Stock client",
            el("span", { class: "mono small" }, [
              Object.entries(report.stockClientPackages)
                .map(([name, version]) => `${name}@${version}`)
                .join("  "),
            ]),
          )
        : undefined,
      el("p", { class: "muted small" }, [
        "Those packages come from the public registry at pinned versions. Nothing in them was " +
          "written by this project, which is what makes the run meaningful.",
      ]),
    ]),

    el("section", { class: "wire-section" }, [
      el("h3", {}, ["Transactions this run settled"]),
      el("p", { class: "muted" }, [
        "Open any of them. They are on the public testnet ledger and do not depend on this page " +
          "being honest.",
      ]),
      el("div", { class: "card" }, [
        txRow(report.settledTransaction, "exact settlement") ??
          el("p", { class: "muted" }, ["No exact settlement recorded."]),
        txRow(report.uptoPartialTransaction, "upto, partial settlement"),
        txRow(report.uptoZeroTransaction, "upto, zero settlement"),
        report.uptoContract
          ? field("upto contract", el("code", { class: "inline" }, [report.uptoContract]))
          : undefined,
      ]),
    ]),

    el(
      "section",
      { class: "wire-section" },
      [
        el("h3", {}, ["Every check"]),
        ...[...groups.entries()].map(([group, checks]) =>
          el("div", { class: "check-group" }, [
            el("h4", {}, [group]),
            el(
              "ul",
              { class: "checks" },
              checks.map((check) =>
                el("li", { class: check.passed ? "check-ok" : "check-fail" }, [
                  el("span", { class: "check-mark" }, [check.passed ? "✓" : "✕"]),
                  el("div", {}, [
                    el("div", { class: "check-label" }, [check.name]),
                    check.error ? el("div", { class: "muted small" }, [check.error]) : undefined,
                  ]),
                ]),
              ),
            ),
          ]),
        ),
      ],
    ),

    json(report, "The report, verbatim"),
  );
}
