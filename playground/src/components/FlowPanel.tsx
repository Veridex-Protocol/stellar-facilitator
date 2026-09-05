"use client";

import React, { useState } from "react";
import {
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
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
  getFacilitatorCapabilities,
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

    try {
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
      const currentRun: RunRecord = {
        startedAt,
        wallet: activeWallet,
      };

      // Step 1: Supported
      const t0 = Date.now();
      updateStep("supported", { state: "running" });
      const supBody = await getFacilitatorCapabilities(config);
      const supportedKind = Array.isArray(supBody.kinds)
        ? supBody.kinds.find(
            (kind: any) =>
              kind.x402Version === 2 &&
              kind.scheme === "exact" &&
              kind.network === config.network
          )
        : undefined;
      if (!supportedKind) {
        throw new Error(`Facilitator does not advertise x402 v2 exact on ${config.network}`);
      }
      if (typeof supportedKind.extra?.areFeesSponsored !== "boolean") {
        throw new Error("Facilitator did not declare extra.areFeesSponsored");
      }
      updateStep("supported", {
        state: "ok",
        ms: Date.now() - t0,
        summary: `Exact · ${config.network} · fees ${
          supportedKind.extra.areFeesSponsored ? "sponsored" : "not sponsored"
        }`,
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
      const message = e.message || "Payment execution encountered an error";
      setErrorMsg(message);
      setSteps((prev) =>
        prev.map((step) =>
          step.state === "running" ? { ...step, state: "failed", error: message } : step
        )
      );
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Wallet Summary Card */}
      <div className="glass-panel rounded-[24px] p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.07] pb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-purple-400/25 bg-purple-500/10 text-purple-200">
              <Wallet className="h-[18px] w-[18px]" />
            </div>
            <div>
              <p className="section-kicker mb-1">Client identity</p>
              <h3 className="text-base font-extrabold tracking-tight text-white">Ephemeral testnet wallet</h3>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                Generated in-browser · Zero server custody
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreateOrFundWallet}
              disabled={isRunning}
              className="primary-action rounded-xl px-3.5 py-2 text-[11px] font-extrabold disabled:cursor-not-allowed disabled:opacity-50"
            >
              {wallet ? "Fund account" : "Generate & fund"}
            </button>
            {wallet && (
              <button
                onClick={handleResetWallet}
                disabled={isRunning}
                className="secondary-action rounded-xl px-3.5 py-2 text-[11px] font-bold disabled:cursor-not-allowed disabled:opacity-50"
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {wallet ? (
          <div className="grid grid-cols-1 gap-3 font-mono text-xs md:grid-cols-2">
            <div className="rounded-2xl border border-white/[0.06] bg-black/35 p-4">
              <span className="mb-1.5 block text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-600">Public address</span>
              <span className="break-all text-zinc-300">{wallet.publicKey}</span>
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-white/[0.06] bg-black/35 p-4">
              <div>
                <span className="mb-1.5 block text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-600">Available balance</span>
                <span className="text-sm font-bold text-white">
                  {balance} XLM <span className="text-purple-300">· testnet</span>
                </span>
              </div>
              <a
                href={`${config.explorerTxUrl.replace("/tx", "/account")}/${wallet.publicKey}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-white/10 bg-white/[0.04] p-2 text-purple-300 transition-colors hover:border-purple-400/30 hover:bg-purple-500/10"
                title="View on Stellar Expert Explorer"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-purple-400/20 bg-purple-500/[0.06] p-4 text-xs leading-relaxed text-purple-100/80">
            Select <strong className="text-white">Generate & fund</strong> or begin the run below. A fresh keypair is created in this tab and funded with testnet XLM.
          </div>
        )}
      </div>

      {/* Primary Action Button */}
      <div className="glass-panel relative flex flex-wrap items-center justify-between gap-5 overflow-hidden rounded-[24px] p-5 sm:p-6">
        <div className="purple-orb pointer-events-none absolute -right-16 -top-20 h-52 w-52 opacity-30" />
        <div className="relative max-w-xl">
          <p className="section-kicker mb-1.5">Live execution</p>
          <h2 className="text-lg font-extrabold tracking-tight text-white">Run the complete payment path</h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Challenge, sign, pre-flight, settle, and confirm against Stellar testnet.
          </p>
        </div>
        <button
          onClick={executePaymentFlow}
          disabled={isRunning}
          className="primary-action relative flex items-center gap-2.5 rounded-2xl px-5 py-3 text-xs font-extrabold disabled:cursor-not-allowed disabled:opacity-50 sm:px-6"
        >
          {isRunning ? (
            <>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              <span>Settling on Stellar</span>
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>Run live payment</span>
              <span className="font-mono text-[9px] text-purple-200">~20s</span>
            </>
          )}
        </button>
      </div>

      {errorMsg && (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.07] p-4 text-xs text-rose-200">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-400" />
          <div>
            <strong className="mb-0.5 block font-bold">Payment execution stopped</strong>
            <span>{errorMsg}</span>
          </div>
        </div>
      )}

      {/* Stepper Timeline */}
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1 pb-1">
          <p className="section-kicker">Execution trace</p>
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-600">6 protocol stages</span>
        </div>
        {steps.map((step) => {
          const isPending = step.state === "pending";
          const isRunningState = step.state === "running";
          const isOk = step.state === "ok";
          const isFailed = step.state === "failed";

          return (
            <div
              key={step.id}
              className={`rounded-2xl border p-4 transition-all sm:p-[18px] ${
                isRunningState
                  ? "border-purple-400/45 bg-purple-500/[0.09] shadow-[0_0_28px_rgba(147,51,234,0.12)]"
                  : isOk
                  ? "border-emerald-500/20 bg-emerald-500/[0.035]"
                  : isFailed
                  ? "border-rose-500/35 bg-rose-500/[0.07]"
                  : "border-white/[0.06] bg-white/[0.018] text-zinc-500"
              }`}
            >
              <div className="flex items-start gap-3.5">
                <div className="mt-0.5">
                  {isOk && <CheckCircle2 className="h-[18px] w-[18px] text-emerald-400" />}
                  {isFailed && <XCircle className="h-[18px] w-[18px] text-rose-400" />}
                  {isRunningState && (
                    <div className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-purple-300 border-t-transparent" />
                  )}
                  {isPending && <div className="h-[18px] w-[18px] rounded-full border border-white/15 bg-black/30" />}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-bold text-white">{step.title}</span>
                    {step.ms !== undefined && (
                      <span className="font-mono text-[10px] text-zinc-600">{step.ms} ms</span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{step.note}</p>

                  {step.summary && (
                    <div className="mt-3 rounded-xl border border-white/[0.06] bg-black/40 p-2.5 font-mono text-[11px] text-emerald-300">
                      {step.summary}
                    </div>
                  )}
                  {step.error && (
                    <div className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/[0.06] p-2.5 font-mono text-[11px] text-rose-200">
                      {step.error}
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
        <div className="glass-panel rounded-[24px] border-emerald-500/30 p-5 shadow-[0_24px_70px_rgba(16,185,129,0.08)] sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-4 border-b border-white/[0.07] pb-4">
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
              className="flex items-center gap-1.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-2 font-mono text-[10px] text-emerald-300 transition-colors hover:bg-emerald-500/15"
            >
              <span>Inspect on Explorer</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono">
              <div className="p-3 rounded-lg bg-black/40 border border-white/5">
                <span className="block text-[9px] uppercase tracking-[0.18em] text-zinc-600">Transaction hash</span>
                <span className="break-all text-zinc-300">{run.txHash}</span>
              </div>
              <div className="p-3 rounded-lg bg-black/40 border border-white/5">
                <span className="block text-[9px] uppercase tracking-[0.18em] text-zinc-600">Settled asset</span>
                <span className="text-purple-300">Native XLM (SAC)</span>
              </div>
              <div className="p-3 rounded-lg bg-black/40 border border-white/5">
                <span className="block text-[9px] uppercase tracking-[0.18em] text-zinc-600">Confirmation duration</span>
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
