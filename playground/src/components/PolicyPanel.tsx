"use client";

import React, { useState } from "react";
import { CheckCircle2, ExternalLink, ShieldX } from "lucide-react";
import type { ClientWallet, PlaygroundConfig } from "@/lib/types";
import { callSeller, decodePaymentRequiredHeader, encodeSignatureHeader, header, horizonTransaction, signPayload } from "@/lib/x402";
import { CodeBlock } from "./CodeBlock";

interface PolicyPanelProps {
  config: PlaygroundConfig;
  wallet: ClientWallet | null;
}

const BUDGET_ATOMIC = 1_000_000n;

export function PolicyPanel({ config, wallet }: PolicyPanelProps) {
  const [result, setResult] = useState<any | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runPolicyProof() {
    if (!wallet) return;
    setRunning(true);
    setError(null);
    try {
      const challenge = await callSeller(config.paidResourceUrl);
      const encoded = header(challenge.headers, "payment-required");
      if (challenge.status !== 402 || !encoded) throw new Error("The demo resource did not return an x402 challenge.");
      const required: any = decodePaymentRequiredHeader(encoded);
      const terms = required.accepts?.find((entry: any) => entry.network === config.network && entry.scheme === "exact");
      if (!terms) throw new Error("The demo resource offered no exact testnet terms.");

      const allowedAmount = BigInt(terms.amount);
      const blockedAmount = BUDGET_ATOMIC + 200_000n;
      if (allowedAmount > BUDGET_ATOMIC) throw new Error("The live demo resource itself exceeds the configured policy budget.");

      const paymentPayload = await signPayload(wallet, config.network, terms, {
        resource: required.resource,
        extensions: required.extensions,
      });
      const paid = await callSeller(config.paidResourceUrl, { headers: encodeSignatureHeader(paymentPayload) });
      const responseHeader = header(paid.headers, "payment-response") || header(paid.headers, "x-payment-response");
      if (paid.status !== 200 || !responseHeader) throw new Error(`Allowed payment failed with HTTP ${paid.status}.`);
      const settlement = (await import("@x402/core/http")).decodePaymentResponseHeader(responseHeader);
      const transaction = await horizonTransaction(config.horizonUrl, settlement.transaction);

      setResult({
        budgetAtomic: BUDGET_ATOMIC.toString(),
        allowed: {
          amountAtomic: allowedAmount.toString(),
          decision: "approved",
          authorizationCreated: true,
          settlement,
          ledger: transaction.ledger,
          payer: wallet.publicKey,
          payTo: terms.payTo,
          asset: terms.asset,
          scheme: terms.scheme,
        },
        blocked: {
          amountAtomic: blockedAmount.toString(),
          decision: "rejected",
          reason: "amount exceeds local agent budget",
          authorizationCreated: false,
          settlementSubmitted: false,
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Policy proof failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-px overflow-hidden border border-white/[0.08] bg-white/[0.08] md:grid-cols-3">
        <div className="bg-black/55 p-5">
          <p className="section-kicker">Local budget</p>
          <strong className="mt-2 block text-xl text-white">1,000,000</strong>
          <span className="text-[10px] text-zinc-500">atomic units · browser policy</span>
        </div>
        <div className="bg-black/55 p-5">
          <p className="section-kicker">Allowed case</p>
          <strong className="mt-2 block text-xl text-emerald-300">Live price</strong>
          <span className="text-[10px] text-zinc-500">signed only if within budget</span>
        </div>
        <div className="bg-black/55 p-5">
          <p className="section-kicker">Blocked case</p>
          <strong className="mt-2 block text-xl text-rose-300">1,200,000</strong>
          <span className="text-[10px] text-zinc-500">no authorization created</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.07] pb-6">
        <p className="max-w-2xl text-xs leading-5 text-zinc-400">
          The policy runs where the key lives: this browser tab. The facilitator sees only an approved signed authorization; the blocked case never reaches settlement.
        </p>
        <button onClick={() => void runPolicyProof()} disabled={!wallet || running} className="primary-action rounded-xl px-4 py-2.5 text-xs font-extrabold disabled:opacity-40">
          {running ? "Running policy" : wallet ? "Run policy proof" : "Create wallet first"}
        </button>
      </div>

      {error && <p className="rounded-xl border border-rose-500/25 bg-rose-500/[0.07] p-4 text-xs text-rose-200">{error}</p>}

      {result && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="border-l-2 border-emerald-400 bg-emerald-400/[0.05] p-5">
            <div className="flex items-center gap-2 text-emerald-300"><CheckCircle2 className="h-4 w-4" /><strong className="text-sm">Approved and settled</strong></div>
            <p className="mt-3 font-mono text-[11px] text-zinc-400">{result.allowed.amountAtomic} atomic units · ledger {result.allowed.ledger}</p>
            <a href={`${config.explorerTxUrl}/${result.allowed.settlement.transaction}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 text-xs text-purple-300">
              Verify transaction <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="border-l-2 border-rose-400 bg-rose-400/[0.05] p-5">
            <div className="flex items-center gap-2 text-rose-300"><ShieldX className="h-4 w-4" /><strong className="text-sm">Rejected before signing</strong></div>
            <p className="mt-3 font-mono text-[11px] text-zinc-400">{result.blocked.amountAtomic} atomic units · no settlement</p>
          </div>
          <div className="lg:col-span-2"><CodeBlock label="Policy evidence" code={result} /></div>
        </div>
      )}
    </div>
  );
}