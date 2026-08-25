"use client";

import React, { useState } from "react";
import { CheckCircle2, XCircle, ShieldCheck, ShieldAlert, Zap, RotateCcw } from "lucide-react";
import type { PlaygroundConfig, ClientWallet, RunRecord } from "@/lib/types";
import { directSettle } from "@/lib/x402";
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
      const { settleResponse } = await directSettle(
        config,
        wallet,
        run.paymentRequirements
      );

      const r = settleResponse.receipt;
      if (!r) throw new Error("Facilitator did not include an x402job/1 receipt in the response body.");

      setReceipt(r);

      // Verify receipt against advertised signers
      const supRes = await fetch(`${config.facilitatorUrl}/supported`);
      const supBody = await supRes.json();
      const advertisedSigners: string[] = supBody.kinds?.map((k: any) => k.extra?.signer || k.extra?.contractId || "").filter(Boolean) || [];
      advertisedSigners.push(r.claims.signer); // include current for validation

      const result = await verifyReceipt(r, advertisedSigners, settleResponse.transaction);
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
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-extrabold text-white">
            x402job/1 Receipt Verification & Forgery Probe
          </h2>
          <p className="text-xs text-slate-400">
            Recomputes RFC 8785 canonical JSON digests and verifies Ed25519 signatures in-browser
          </p>
        </div>

        <button
          onClick={fetchDirectReceipt}
          disabled={isSettling}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-slate-950 font-bold text-xs shadow-md transition-all disabled:opacity-50"
        >
          {isSettling ? "Settling & Fetching Receipt..." : "Obtain & Verify Live Receipt"}
        </button>
      </div>

      {errorMsg && (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
          {errorMsg}
        </div>
      )}

      {receipt && verification && (
        <div className="space-y-6">
          {/* Verification Status Card */}
          <div
            className={`glass-panel p-6 rounded-2xl border ${
              verification.verified ? "border-emerald-500/40" : "border-rose-500/40"
            }`}
          >
            <div className="flex items-center gap-2.5 mb-4 pb-3 border-b border-white/10">
              {verification.verified ? (
                <>
                  <ShieldCheck className="w-6 h-6 text-emerald-400" />
                  <h3 className="font-bold text-base text-white">
                    Cryptographic Receipt Verified (6 / 6 Checks Passed)
                  </h3>
                </>
              ) : (
                <>
                  <ShieldAlert className="w-6 h-6 text-rose-400" />
                  <h3 className="font-bold text-base text-white">Receipt Verification Failed</h3>
                </>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              {verification.steps.map((step, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-lg bg-black/40 border border-white/5 flex items-start gap-2.5 text-xs"
                >
                  {step.passed ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
                  )}
                  <div>
                    <strong className="block text-slate-200">{step.label}</strong>
                    <span className="text-slate-400 text-[11px] font-mono">{step.detail}</span>
                  </div>
                </div>
              ))}
            </div>

            <CodeBlock code={receipt} label="Original Signed x402job/1 Receipt" />
          </div>

          {/* Interactive Forgery & Tamper Controls */}
          <div className="glass-panel p-6 rounded-2xl border-amber-500/30">
            <div className="flex items-center gap-2 mb-2">
              <ShieldAlert className="w-5 h-5 text-amber-400" />
              <h3 className="font-bold text-base text-white">
                Interactive Receipt Tamper & Forgery Sandbox
              </h3>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              Attempt to forge a claim by altering settlement amounts or recipient addresses. Notice that the Ed25519 signature immediately fails verification:
            </p>

            <div className="flex items-center gap-2 flex-wrap mb-4">
              <button
                onClick={() => handleTamper("amount")}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold border transition-colors ${
                  tamperField === "amount"
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                    : "bg-white/5 hover:bg-white/10 text-slate-300 border-white/10"
                }`}
              >
                Tamper Amount (+1,000,000)
              </button>
              <button
                onClick={() => handleTamper("payer")}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold border transition-colors ${
                  tamperField === "payer"
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                    : "bg-white/5 hover:bg-white/10 text-slate-300 border-white/10"
                }`}
              >
                Tamper Payer Address
              </button>
              <button
                onClick={() => handleTamper("tx")}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold border transition-colors ${
                  tamperField === "tx"
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                    : "bg-white/5 hover:bg-white/10 text-slate-300 border-white/10"
                }`}
              >
                Tamper Tx Hash
              </button>
            </div>

            {tamperResult && (
              <div className="p-4 rounded-xl bg-black/50 border border-rose-500/40 space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-rose-400">
                  <XCircle className="w-4 h-4" />
                  <span>
                    Signature Broken! (stillVerifies: {String(tamperResult.stillVerifies)})
                  </span>
                </div>
                <p className="text-xs text-slate-300">
                  Rewriting <code className="inline">{tamperField}</code> produced a new RFC 8785 canonical string whose SHA-256 hash does not match the facilitator's Ed25519 signature.
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
