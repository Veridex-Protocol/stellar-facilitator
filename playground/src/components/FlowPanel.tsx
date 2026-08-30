"use client";

import React, { useState } from "react";
import {
  Play,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
  Copy,
  Wallet,
  AlertCircle,
} from "lucide-react";
import type { PlaygroundConfig, ClientWallet, Step, RunRecord } from "@/lib/types";
import {
  fundFromFriendbot,
  fetchNativeBalance,
  waitForRpcVisibility,
  createWallet,
  forgetWallet,
} from "@/lib/wallet";
import {
  callSeller,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  header,
  horizonTransaction,
  postFacilitator,
  signPayload,
  encodeSignatureHeader,
} from "@/lib/x402";
import { CodeBlock } from "./CodeBlock";

interface FlowPanelProps {
  config: PlaygroundConfig;
  wallet: ClientWallet | null;
  setWallet: (w: ClientWallet | null) => void;
  balance: string;
  setBalance: (b: string) => void;
  run: RunRecord | null;
  setRun: (r: RunRecord | null) => void;
}

const INITIAL_STEPS: Step[] = [
  {
    id: "supported",
    title: "1. Query Facilitator Capabilities",
    note: "GET /supported - Confirms scheme and fee sponsorship against Stellar network",
    state: "pending",
  },
  {
    id: "challenge",
    title: "2. Request Protected Resource",
    note: "GET /paid-resource - Seller answers HTTP 402 with PAYMENT-REQUIRED terms",
    state: "pending",
  },
  {
    id: "sign",
    title: "3. Sign Soroban Authorization Entry",
    note: "Signed in this browser tab via @x402/stellar. Keys never leave the client.",
    state: "pending",
  },
  {
    id: "verify",
    title: "4. Facilitator Pre-Flight Check",
    note: "POST /verify - Verifies authorization without settling or spending fees",
    state: "pending",
  },
  {
    id: "pay",
    title: "5. Settle Payment on Stellar",
    note: "Facilitator submits FeeBump tx through channel pool and serves resource",
    state: "pending",
  },
  {
    id: "confirm",
    title: "6. Ledger Re-Read Confirmation",
    note: "Confirms transaction and fee settlement directly from Horizon ledger",
    state: "pending",
  },
];

export function FlowPanel({
  config,
  wallet,
  setWallet,
  balance,
  setBalance,
  run,
  setRun,
}: FlowPanelProps) {
  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS);
  const [isRunning, setIsRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const updateStep = (id: string, update: Partial<Step>) => {
    setSteps((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...update } : s))
    );
  };

  const handleCreateOrFundWallet = async () => {
    try {
      setErrorMsg(null);
      let activeWallet = wallet;
      if (!activeWallet) {
        activeWallet = createWallet();
        setWallet(activeWallet);
      }
      await fundFromFriendbot(config.friendbotUrl, activeWallet.publicKey);
      await waitForRpcVisibility(config.rpcUrl, activeWallet.publicKey);
      const bal = await fetchNativeBalance(config.horizonUrl, activeWallet.publicKey);
      setBalance(bal);
    } catch (e: any) {
      setErrorMsg(e.message || "Failed to fund wallet from Friendbot");
    }
  };

  const handleResetWallet = () => {
    forgetWallet();
    setWallet(null);
    setBalance("0.00");
    setRun(null);
    setSteps(INITIAL_STEPS);
  };

  const executePaymentFlow = async () => {
    if (isRunning) return;
    setIsRunning(true);
    setErrorMsg(null);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, state: "pending", summary: undefined, error: undefined, ms: undefined })));

    let activeWallet = wallet;
    if (!activeWallet) {
      activeWallet = createWallet();
      setWallet(activeWallet);
      await fundFromFriendbot(config.friendbotUrl, activeWallet.publicKey);
      await waitForRpcVisibility(config.rpcUrl, activeWallet.publicKey);
      const bal = await fetchNativeBalance(config.horizonUrl, activeWallet.publicKey);
      setBalance(bal);
    }

    const startedAt = new Date().toISOString();
    let currentRun: RunRecord = {
      startedAt,
      wallet: activeWallet,
    };

    try {
      // Step 1: Supported
      const t0 = Date.now();
      updateStep("supported", { state: "running" });
      const supRes = await fetch(`${config.facilitatorUrl}/supported`);
      if (!supRes.ok) throw new Error(`/supported failed (${supRes.status})`);
      const supBody = await supRes.json();
      updateStep("supported", {
        state: "ok",
        ms: Date.now() - t0,
        summary: `Supported schemes: ${supBody.kinds?.length || 1} (fees sponsored)`,
      });

      // Step 2: Challenge
      const t1 = Date.now();
      updateStep("challenge", { state: "running" });
      const chalRes = await callSeller(config.paidResourceUrl);
      if (chalRes.status !== 402) {
        throw new Error(`Expected HTTP 402 from seller, got ${chalRes.status}`);
      }
      const rawReq = header(chalRes.headers, "PAYMENT-REQUIRED");
      if (!rawReq) throw new Error("No PAYMENT-REQUIRED header in 402 response");
      const decodedChal: any = decodePaymentRequiredHeader(rawReq);
      const terms = decodedChal.accepts?.find((a: any) => a.network === config.network);
      if (!terms) throw new Error(`No terms offered for network ${config.network}`);
      currentRun.paymentRequirements = terms;
      updateStep("challenge", {
        state: "ok",
        ms: Date.now() - t1,
        summary: `Demanded ${terms.amount} atomic units of SEP-41 asset`,
      });

      // Step 3: Sign
      const t2 = Date.now();
      updateStep("sign", { state: "running" });
      const paymentPayload = await signPayload(activeWallet, config.network, terms, {
        resource: decodedChal.resource,
        extensions: decodedChal.extensions,
      });
      currentRun.paymentPayload = paymentPayload;
      updateStep("sign", {
        state: "ok",
        ms: Date.now() - t2,
        summary: `Ed25519 authorization signed (${paymentPayload.payload.transaction.length} base64 chars)`,
      });

      // Step 4: Verify
      const t3 = Date.now();
      updateStep("verify", { state: "running" });
      const { body: verifyBody } = await postFacilitator(config, "/verify", {
        paymentPayload,
        paymentRequirements: terms,
      });
      if (!verifyBody.isValid) {
        throw new Error(`Facilitator rejected payload: ${verifyBody.invalidReason}`);
      }
      currentRun.verifyResponse = verifyBody;
      updateStep("verify", {
        state: "ok",
        ms: Date.now() - t3,
        summary: "Pre-flight validation passed (0 fees charged)",
      });

      // Step 5: Pay & Settle
      const t4 = Date.now();
      updateStep("pay", { state: "running" });
      const payHeaders = {
        accept: "application/json",
        ...encodeSignatureHeader(paymentPayload),
      };
      const payRes = await callSeller(config.paidResourceUrl, { headers: payHeaders });
      if (payRes.status !== 200) {
        throw new Error(`Payment failed with HTTP ${payRes.status}`);
      }
      const rawSettle = header(payRes.headers, "PAYMENT-RESPONSE") || header(payRes.headers, "X-PAYMENT-RESPONSE");
      if (!rawSettle) throw new Error("No PAYMENT-RESPONSE header in 200 response");
      const settleResponse: any = decodePaymentResponseHeader(rawSettle);
      currentRun.settleResponse = settleResponse;
      currentRun.resourceResponse = payRes.body;
      currentRun.txHash = settleResponse.transaction;
      updateStep("pay", {
        state: "ok",
        ms: Date.now() - t4,
        summary: `Settled tx: ${settleResponse.transaction?.slice(0, 16)}...`,
      });

      // Step 6: Confirm
      const t5 = Date.now();
      updateStep("confirm", { state: "running" });
      const horizonTx = await horizonTransaction(config.horizonUrl, settleResponse.transaction);
      updateStep("confirm", {
        state: "ok",
        ms: Date.now() - t5,
        summary: `Confirmed on ledger #${horizonTx.ledger} (fee: ${horizonTx.fee_charged} stroops)`,
      });

      currentRun.completedAt = new Date().toISOString();
      currentRun.totalMs = Date.now() - t0;
      setRun(currentRun);

      const finalBal = await fetchNativeBalance(config.horizonUrl, activeWallet.publicKey);
      setBalance(finalBal);
    } catch (e: any) {
      setErrorMsg(e.message || "Payment execution encountered an error");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Wallet Summary Card */}
      <div className="glass-panel p-6 rounded-2xl">
        <div className="flex items-center justify-between gap-4 mb-4 pb-3 border-b border-white/10 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-sky-500/10 text-sky-400 border border-sky-400/20">
              <Wallet className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base text-white">Client Testnet Wallet</h3>
              <p className="text-xs text-slate-400">
                Ephemeral in-browser keypair · Zero server custody
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreateOrFundWallet}
              disabled={isRunning}
              className="px-3 py-1.5 text-xs font-bold rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 transition-colors shadow-sm"
            >
              {wallet ? "Fund Account" : "Generate & Fund"}
            </button>
            {wallet && (
              <button
                onClick={handleResetWallet}
                disabled={isRunning}
                className="px-3 py-1.5 text-xs font-bold rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 transition-colors border border-white/10"
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {wallet ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
            <div className="p-3 rounded-lg bg-slate-950/40 border border-white/5">
              <span className="text-slate-500 block text-[11px] mb-1">PUBLIC ADDRESS</span>
              <span className="text-slate-200 break-all">{wallet.publicKey}</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-950/40 border border-white/5 flex items-center justify-between">
              <div>
                <span className="text-slate-500 block text-[11px] mb-1">AVAILABLE BALANCE</span>
                <span className="text-emerald-400 font-bold text-sm">
                  {balance} XLM (Testnet)
                </span>
              </div>
              <a
                href={`${config.explorerTxUrl.replace("/tx", "/account")}/${wallet.publicKey}`}
                target="_blank"
                rel="noreferrer"
                className="p-1.5 rounded bg-white/5 hover:bg-white/10 text-sky-400 transition-colors"
                title="View on Stellar Expert Explorer"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-xl bg-sky-500/5 border border-sky-400/20 text-xs text-sky-300">
            Click <strong>Generate & Fund</strong> or start the payment run below. A fresh keypair will be created in this browser tab and funded with 10,000 testnet XLM automatically.
          </div>
        )}
      </div>

      {/* Primary Action Button */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-extrabold text-white">Live Payment Execution</h2>
          <p className="text-xs text-slate-400">
            Executes a real x402 challenge, cryptographic signing, fee-sponsored settlement, and Horizon verification
          </p>
        </div>
        <button
          onClick={executePaymentFlow}
          disabled={isRunning}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-sky-400 to-indigo-500 hover:from-sky-300 hover:to-indigo-400 text-slate-950 font-bold text-sm shadow-lg shadow-sky-500/25 transition-all transform hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRunning ? (
            <>
              <div className="w-4 h-4 rounded-full border-2 border-slate-950 border-t-transparent animate-spin" />
              <span>Settling on Stellar...</span>
            </>
          ) : (
            <>
              <Play className="w-4 h-4 fill-current" />
              <span>Run Live Payment (~20s)</span>
            </>
          )}
        </button>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-start gap-3 text-xs text-rose-300">
          <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
          <div>
            <strong className="block font-bold mb-0.5">Payment Execution Stopped</strong>
            <span>{errorMsg}</span>
          </div>
        </div>
      )}

      {/* Stepper Timeline */}
      <div className="space-y-3">
        {steps.map((step) => {
          const isPending = step.state === "pending";
          const isRunningState = step.state === "running";
          const isOk = step.state === "ok";
          const isFailed = step.state === "failed";

          return (
            <div
              key={step.id}
              className={`p-4 rounded-xl border transition-all ${
                isRunningState
                  ? "bg-sky-500/10 border-sky-400 shadow-[0_0_20px_rgba(56,189,248,0.2)]"
                  : isOk
                  ? "bg-slate-900/60 border-emerald-500/30"
                  : isFailed
                  ? "bg-rose-500/10 border-rose-500/40"
                  : "bg-slate-900/30 border-white/5 text-slate-400"
              }`}
            >
              <div className="flex items-start gap-3.5">
                <div className="mt-0.5">
                  {isOk && <CheckCircle2 className="w-5 h-5 text-emerald-400" />}
                  {isFailed && <XCircle className="w-5 h-5 text-rose-400" />}
                  {isRunningState && (
                    <div className="w-5 h-5 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
                  )}
                  {isPending && <div className="w-5 h-5 rounded-full border-2 border-white/10" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-sm text-white">{step.title}</span>
                    {step.ms !== undefined && (
                      <span className="font-mono text-xs text-slate-500">{step.ms} ms</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">{step.note}</p>

                  {step.summary && (
                    <div className="mt-2.5 p-2 rounded-lg bg-black/40 border border-white/5 font-mono text-xs text-emerald-300">
                      {step.summary}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Success Receipt Card */}
      {run && run.txHash && (
        <div className="glass-panel p-6 rounded-2xl border-emerald-500/40 shadow-xl shadow-emerald-500/10">
          <div className="flex items-center justify-between gap-4 mb-4 pb-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              <h3 className="font-bold text-base text-white">
                Payment Settled & Confirmed on Ledger
              </h3>
            </div>
            <a
              href={`${config.explorerTxUrl}/${run.txHash}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-mono transition-colors"
            >
              <span>Inspect on Explorer</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono">
              <div className="p-3 rounded-lg bg-black/40 border border-white/5">
                <span className="text-slate-500 block text-[11px]">TRANSACTION HASH</span>
                <span className="text-slate-200 break-all">{run.txHash}</span>
              </div>
              <div className="p-3 rounded-lg bg-black/40 border border-white/5">
                <span className="text-slate-500 block text-[11px]">SETTLED ASSET</span>
                <span className="text-sky-300">Native XLM (SAC)</span>
              </div>
              <div className="p-3 rounded-lg bg-black/40 border border-white/5">
                <span className="text-slate-500 block text-[11px]">CONFIRMATION DURATION</span>
                <span className="text-emerald-400 font-bold">{run.totalMs} ms</span>
              </div>
            </div>

            {run.resourceResponse && (
              <CodeBlock code={run.resourceResponse} label="Delivered Resource Data Payload" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
