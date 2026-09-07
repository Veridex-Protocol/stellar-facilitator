"use client";

import React, { useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Network,
  Play,
  Search,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import type { ClientWallet, GatewayRunRecord, PlaygroundConfig } from "@/lib/types";
import {
  callSeller,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodeSignatureHeader,
  header,
  horizonTransaction,
  signPayload,
} from "@/lib/x402";
import {
  createWallet,
  fetchNativeBalance,
  fundFromFriendbot,
  waitForRpcVisibility,
} from "@/lib/wallet";
import { fetchWithTimeout } from "@/lib/http";
import { CodeBlock } from "./CodeBlock";

interface GatewayPanelProps {
  config: PlaygroundConfig;
  wallet: ClientWallet | null;
  setWallet: (wallet: ClientWallet | null) => void;
  setBalance: (balance: string) => void;
}

type Stage = "configure" | "ready" | "paying" | "complete";

export function GatewayPanel({ config, wallet, setWallet, setBalance }: GatewayPanelProps) {
  const [stage, setStage] = useState<Stage>("configure");
  const [challenge, setChallenge] = useState<any | null>(null);
  const [run, setRun] = useState<GatewayRunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function activateGateway() {
    setError(null);
    setRun(null);
    try {
      const health = await callSeller(config.gatewayUrl + "/health");
      if (health.status !== 200) throw new Error(`Gateway health check failed (${health.status})`);
      const response = await callSeller(config.gatewayResourceUrl);
      if (response.status !== 402) throw new Error(`Expected gateway HTTP 402, received ${response.status}`);
      const required = header(response.headers, "PAYMENT-REQUIRED");
      if (!required) throw new Error("Gateway did not return PAYMENT-REQUIRED");
      const decoded = decodePaymentRequiredHeader(required);
      const terms = decoded.accepts?.find((entry: any) => entry.network === config.network);
      if (!terms) throw new Error(`Gateway offered no ${config.network} payment terms`);
      setChallenge({ response, decoded, terms });
      setStage("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Gateway activation failed");
      setStage("configure");
    }
  }

  async function payGateway() {
    if (!challenge || stage === "paying") return;
    setStage("paying");
    setError(null);
    const startedAt = Date.now();
    try {
      let activeWallet = wallet;
      if (!activeWallet) {
        activeWallet = createWallet();
        setWallet(activeWallet);
        await fundFromFriendbot(config.friendbotUrl, activeWallet.publicKey);
        await waitForRpcVisibility(config.rpcUrl, activeWallet.publicKey);
      }
      const paymentPayload = await signPayload(activeWallet, config.network, challenge.terms, {
        resource: challenge.decoded.resource,
        extensions: challenge.decoded.extensions,
      });
      const response = await callSeller(config.gatewayResourceUrl, {
        headers: { accept: "application/json", ...encodeSignatureHeader(paymentPayload) },
      });
      if (response.status !== 200) throw new Error(`Paid gateway request returned HTTP ${response.status}`);
      const paymentResponse = header(response.headers, "PAYMENT-RESPONSE");
      if (!paymentResponse) throw new Error("Gateway response did not include PAYMENT-RESPONSE");
      const settlement = decodePaymentResponseHeader(paymentResponse);
      const transaction = await horizonTransaction(config.horizonUrl, settlement.transaction);
      const providerOutcome = decodeProviderOutcome(header(response.headers, "X-Veridex-Provider-Outcome"));
      const bazaar = await findBazaarListing(config, config.gatewayResourceUrl);
      const balance = await fetchNativeBalance(config.horizonUrl, activeWallet.publicKey);
      setBalance(balance);
      setRun({
        challenge: challenge.decoded,
        paymentPayload,
        settlement,
        transaction,
        upstreamResponse: response.body,
        providerOutcome,
        bazaar,
        totalMs: Date.now() - startedAt,
      });
      setStage("complete");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Gateway payment failed");
      setStage("ready");
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 border-b border-white/[0.07] pb-6 md:grid-cols-2">
        <div>
          <p className="section-kicker">Lowest-friction seller path</p>
          <h3 className="mt-2 text-xl font-extrabold text-white">Keep your API. Put x402 in front.</h3>
          <p className="mt-2 max-w-xl text-xs leading-5 text-zinc-400">
            This public demo uses one allowlisted upstream. The gateway preserves the request, settles through the existing facilitator, then calls the original API.
          </p>
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg border border-white/10 bg-black/35 p-4">
          <div className="min-w-0">
            <span className="block font-mono text-[9px] uppercase text-zinc-600">Native</span>
            <strong className="mt-1 block text-xs text-white">Full control</strong>
          </div>
          <ArrowRight className="h-4 w-4 text-zinc-600" />
          <div className="min-w-0 text-right">
            <span className="block font-mono text-[9px] uppercase text-emerald-400">Gateway</span>
            <strong className="mt-1 block text-xs text-white">Minimum effort</strong>
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <ReadOnlyField label="Existing API URL" value={config.gatewayUpstreamUrl} wide />
            <ReadOnlyField label="Network" value={config.network} />
            <ReadOnlyField label="Asset" value={challenge?.terms.asset ?? config.paymentAsset} />
            <ReadOnlyField label="Price" value={challenge?.terms.amount ?? "Read from gateway challenge"} />
            <ReadOnlyField label="PayTo" value={challenge?.terms.payTo ?? "Read from gateway challenge"} wide />
          </div>

          <button
            onClick={() => void activateGateway()}
            disabled={stage === "paying"}
            className="secondary-action flex h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-xs font-extrabold disabled:opacity-50"
          >
            <Network className="h-4 w-4" />
            {stage === "configure" ? "Activate Demo Gateway" : "Refresh Gateway Challenge"}
          </button>

          {challenge && (
            <div className="space-y-3 border-l-2 border-emerald-400 bg-emerald-500/[0.05] p-4">
              <div className="flex items-center gap-2 text-xs font-bold text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> Gateway active
              </div>
              <dl className="space-y-2 font-mono text-[10px]">
                <Row label="Gateway URL" value={config.gatewayUrl} />
                <Row label="402 endpoint" value={config.gatewayResourceUrl} />
                <Row label="Bazaar" value="Declared; indexed after settlement" />
              </dl>
            </div>
          )}

          <button
            onClick={() => void payGateway()}
            disabled={!challenge || stage === "paying"}
            className="primary-action flex h-12 w-full items-center justify-center gap-2 rounded-xl px-4 text-xs font-extrabold disabled:cursor-not-allowed disabled:opacity-40"
          >
            {stage === "paying" ? <Wallet className="h-4 w-4 animate-pulse" /> : <Play className="h-4 w-4" />}
            {stage === "paying" ? "Signing and settling on testnet" : "Pay and Call Existing API"}
          </button>

          {error && <p className="border-l-2 border-rose-400 bg-rose-500/[0.06] p-4 text-xs text-rose-200">{error}</p>}
        </section>

        <section className="min-w-0 border-l border-white/[0.07] pl-0 xl:pl-6">
          {!run ? (
            <div className="flex min-h-[390px] flex-col items-center justify-center gap-3 text-center text-zinc-500">
              <ShieldCheck className="h-8 w-8 text-zinc-700" />
              <p className="text-xs">Activate the gateway, then complete a real Stellar testnet payment.</p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="section-kicker">Settlement proof</p>
                  <h3 className="mt-2 text-lg font-extrabold text-white">Existing API response delivered</h3>
                  <p className="mt-1 text-xs text-zinc-500">End to end in {(run.totalMs / 1000).toFixed(1)} seconds</p>
                </div>
                <a
                  href={`${config.explorerTxUrl}/${run.settlement.transaction}`}
                  target="_blank"
                  rel="noreferrer"
                  className="secondary-action flex items-center gap-2 rounded-xl px-3 py-2 text-[11px] text-purple-200"
                >
                  Verify on Stellar <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>

              <div className="grid gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 sm:grid-cols-2">
                <Proof label="Scheme" value={run.challenge.accepts[0].scheme} />
                <Proof label="Network" value={run.settlement.network} />
                <Proof label="Authorized" value={run.challenge.accepts[0].amount} />
                <Proof label="Settled" value={run.challenge.accepts[0].amount} />
                <Proof label="Payer" value={run.settlement.payer} />
                <Proof label="PayTo" value={run.challenge.accepts[0].payTo} />
                <Proof label="Asset" value={run.challenge.accepts[0].asset} />
                <Proof label="Ledger" value={String(run.transaction.ledger)} />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <Status label="Upstream" value="Response received" ok />
                <Status label="Bazaar" value={run.bazaar ? "Indexed" : "Queued"} ok={Boolean(run.bazaar)} />
                <Status label="Provider" value={run.providerOutcome?.reasonCode ?? "Recorded"} ok={run.providerOutcome?.usable !== false} />
              </div>

              <CodeBlock label="Original API response" code={run.upstreamResponse} />
              <CodeBlock label="Gateway payment event evidence" code={{
                transactionHash: run.settlement.transaction,
                ledger: run.transaction.ledger,
                providerOutcome: run.providerOutcome ?? null,
                bazaar: run.bazaar ?? { status: "queued" },
              }} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ReadOnlyField({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <label className={wide ? "sm:col-span-2" : ""}>
      <span className="section-kicker mb-2 block">{label}</span>
      <input readOnly value={value} className="h-11 w-full rounded-lg border border-white/10 bg-black/40 px-3 font-mono text-[10px] text-zinc-300 outline-none" />
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-3"><dt className="text-zinc-600">{label}</dt><dd className="truncate text-zinc-300">{value}</dd></div>;
}

function Proof({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 bg-black/70 p-3"><span className="block font-mono text-[9px] uppercase text-zinc-600">{label}</span><strong className="mt-1 block truncate font-mono text-[10px] text-zinc-200" title={value}>{value}</strong></div>;
}

function Status({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return <div className="border-l-2 border-white/10 bg-white/[0.025] p-3"><span className="block font-mono text-[9px] uppercase text-zinc-600">{label}</span><span className={`mt-1 flex items-center gap-1.5 text-[11px] ${ok ? "text-emerald-300" : "text-amber-300"}`}>{label === "Bazaar" && <Search className="h-3 w-3" />}{value}</span></div>;
}

function decodeProviderOutcome(raw: string | undefined): any | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(atob(raw));
  } catch {
    return undefined;
  }
}

async function findBazaarListing(config: PlaygroundConfig, resourceUrl: string): Promise<any | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const url = new URL("/discovery/search", config.bazaarUrl);
    url.searchParams.set("q", "gateway hello demo");
    url.searchParams.set("network", config.network);
    url.searchParams.set("limit", "20");
    const response = await fetchWithTimeout(url.toString(), {}, 10_000, "Bazaar gateway lookup");
    if (response.ok) {
      const body = await response.json();
      const match = body.results?.find((entry: any) => entry.resourceUrl === resourceUrl);
      if (match) return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return undefined;
}