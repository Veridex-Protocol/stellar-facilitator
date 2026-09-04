"use client";

import React, { useState } from "react";
import { CheckCircle2, XCircle, ShieldCheck, ShieldAlert } from "lucide-react";
import type { PlaygroundConfig, ClientWallet, RunRecord } from "@/lib/types";
import { directSettle, getFacilitatorDescriptor } from "@/lib/x402";
import { verifyReceipt, tamper, type Receipt, type VerificationResult } from "@/lib/verify";
import { CodeBlock } from "./CodeBlock";

interface ReceiptPanelProps {
  config: PlaygroundConfig;
  wallet: ClientWallet | null;
  run: RunRecord | null;
}

export function ReceiptPanel({ config, wallet, run }: ReceiptPanelProps) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [isSettling, setIsSettling] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [tamperField, setTamperField] = useState<string | null>(null);
  const [tamperResult, setTamperResult] = useState<any | null>(null);

  const fetchDirectReceipt = async () => {
    if (!wallet || !run?.paymentRequirements) {
      setErrorMsg("Run a payment in the Flow tab first so we have active payment terms to settle.");
      return;
    }

    setIsSettling(true);
    setErrorMsg(null);
    setTamperField(null);
    setTamperResult(null);

    try {
      const { paymentPayload, settleResponse } = await directSettle(
        config,
        wallet,
        run.paymentRequirements
      );

      const { receipt: r, ...settlementResult } = settleResponse;
      if (!r) throw new Error("Facilitator did not include an x402job/1 receipt in the response body.");

      setReceipt(r);

      const descriptor = await getFacilitatorDescriptor(config);
      const receiptSigner = descriptor.receipts?.signer;
      if (typeof receiptSigner !== "string") {
        throw new Error("Facilitator descriptor did not advertise a receipt signer.");
      }

      const result = await verifyReceipt(
        r,
        [receiptSigner],
        settleResponse.transaction,
        paymentPayload,
        settlementResult
      );
      setVerification(result);
    } catch (e: any) {
      setErrorMsg(e.message || "Failed to obtain signed receipt");
    } finally {
      setIsSettling(false);
    }
  };

  const handleTamper = (field: "amount" | "payer" | "tx" | "asset") => {
    if (!receipt) return;
    setTamperField(field);

    let fakeVal = "";
    if (field === "amount") fakeVal = String(BigInt(receipt.claims.settlement.amount || "1000") + 1000000n);
    if (field === "payer") fakeVal = "GA6TXRL7J6IXYJODVUNPKTHUTI4YJZAS2RGOM2SV2FJGCRTXACDAIIMZ";
    if (field === "tx") fakeVal = "0000000000000000000000000000000000000000000000000000000000000000";
    if (field === "asset") fakeVal = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC_FAKE";

    const res = tamper(receipt, field, fakeVal);
    setTamperResult(res);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="section-kicker mb-1.5">Integrity laboratory</p>
          <h2 className="text-xl font-extrabold tracking-tight text-white">
            Receipt verification
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Recompute canonical JSON digests, inspect claims, and probe Ed25519 signature integrity in-browser.
          </p>
        </div>

        <button
          onClick={fetchDirectReceipt}
          disabled={isSettling}
          className="primary-action inline-flex min-w-[198px] items-center justify-center rounded-xl px-4 py-3 text-[11px] font-extrabold"
        >
          {isSettling ? "Settling transaction…" : "Obtain live receipt"}
        </button>
      </div>

      {errorMsg && (
        <div className="rounded-2xl border border-rose-500/25 bg-rose-500/[0.07] p-4 text-xs text-rose-200">
          {errorMsg}
        </div>
      )}

      {!receipt && !errorMsg && (
        <div className="glass-panel flex min-h-[340px] flex-col items-center justify-center rounded-[26px] p-8 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-purple-400/25 bg-purple-500/10 text-purple-200">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <p className="section-kicker mb-2">Ready to inspect</p>
          <h3 className="text-lg font-extrabold tracking-tight text-white">Settle and verify a receipt</h3>
          <p className="mt-2 max-w-md text-xs leading-relaxed text-zinc-500">
            Run a payment first, then obtain a live receipt to inspect its signed claims and local integrity checks.
          </p>
        </div>
      )}

      {receipt && verification && (
        <div className="space-y-6">
          <div
            className={`glass-panel rounded-[26px] border p-5 sm:p-6 ${
              verification.verified ? "border-emerald-500/25" : "border-rose-500/30"
            }`}
          >
            <div className="mb-5 flex items-center gap-3 border-b border-white/[0.07] pb-4">
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl border ${verification.verified ? "border-emerald-500/25 bg-emerald-500/[0.08]" : "border-rose-500/25 bg-rose-500/[0.08]"}`}>
                {verification.verified ? (
                  <ShieldCheck className="h-5 w-5 text-emerald-300" />
                ) : (
                  <ShieldAlert className="h-5 w-5 text-rose-300" />
                )}
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-600">Verification result</p>
                <h3 className="mt-0.5 text-sm font-extrabold text-white">
                  {verification.verified ? "All local integrity checks passed" : "Receipt verification failed"}
                </h3>
              </div>
            </div>

            <div className="mb-5 grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {verification.steps.map((step, idx) => (
                <div
                  key={idx}
                  className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-black/40 p-3.5 text-xs"
                >
                  {step.passed ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
                  )}
                  <div>
                    <strong className="block text-zinc-200">{step.label}</strong>
                    <span className="font-mono text-[10px] leading-relaxed text-zinc-500">{step.detail}</span>
                  </div>
                </div>
              ))}
            </div>

            <CodeBlock code={receipt} label="Original Signed x402job/1 Receipt" />
          </div>

          <div className="glass-panel rounded-[26px] border-amber-500/20 p-5 sm:p-6">
            <div className="mb-2 flex items-center gap-2.5">
              <ShieldAlert className="h-5 w-5 text-amber-300" />
              <h3 className="text-sm font-extrabold text-white">
                Tamper probe
              </h3>
            </div>
            <p className="mb-5 max-w-2xl text-xs leading-relaxed text-zinc-500">
              Alter a signed claim locally and compare it against the original signature.
            </p>

            <div className="mb-5 flex flex-wrap items-center gap-2">
              <button
                onClick={() => handleTamper("amount")}
                className={`rounded-xl border px-3.5 py-2.5 font-mono text-[10px] font-bold transition-colors ${
                  tamperField === "amount"
                    ? "border-amber-500/35 bg-amber-500/15 text-amber-200"
                    : "border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:border-purple-400/25 hover:text-white"
                }`}
              >
                Tamper Amount (+1,000,000)
              </button>
              <button
                onClick={() => handleTamper("payer")}
                className={`rounded-xl border px-3.5 py-2.5 font-mono text-[10px] font-bold transition-colors ${
                  tamperField === "payer"
                    ? "border-amber-500/35 bg-amber-500/15 text-amber-200"
                    : "border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:border-purple-400/25 hover:text-white"
                }`}
              >
                Tamper Payer Address
              </button>
              <button
                onClick={() => handleTamper("tx")}
                className={`rounded-xl border px-3.5 py-2.5 font-mono text-[10px] font-bold transition-colors ${
                  tamperField === "tx"
                    ? "border-amber-500/35 bg-amber-500/15 text-amber-200"
                    : "border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:border-purple-400/25 hover:text-white"
                }`}
              >
                Tamper Tx Hash
              </button>
            </div>

            {tamperResult && (
              <div className="space-y-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.04] p-4">
                <div className="flex items-center gap-2 text-xs font-bold text-rose-300">
                  <XCircle className="h-4 w-4" />
                  <span>
                    Altered payload rejected · still verifies: {String(tamperResult.stillVerifies)}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">
                  Changing <code className="inline">{tamperField}</code> produces different canonical claim bytes that no longer match the original Ed25519 signature.
                </p>
                <CodeBlock code={tamperResult.forged} label="Altered (Forged) Receipt Payload" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
