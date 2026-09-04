"use client";

import React, { useEffect, useState } from "react";
import type { PlaygroundConfig, ClientWallet, RunRecord } from "@/lib/types";
import { existingWallet, fetchNativeBalance } from "@/lib/wallet";
import { Navbar } from "@/components/Navbar";
import { Sidebar, type TabId } from "@/components/Sidebar";
import { FlowPanel } from "@/components/FlowPanel";
import { WirePanel } from "@/components/WirePanel";
import { ReceiptPanel } from "@/components/ReceiptPanel";
import { RefusalsPanel } from "@/components/RefusalsPanel";
import { EvidencePanel } from "@/components/EvidencePanel";

const TAB_DETAILS: Record<TabId, { number: string; label: string; description: string }> = {
  flow: {
    number: "01",
    label: "Payment flow",
    description: "Execute a complete x402 payment against Stellar testnet.",
  },
  wire: {
    number: "02",
    label: "Wire protocol",
    description: "Inspect the payloads and authorization entries exchanged on the wire.",
  },
  receipt: {
    number: "03",
    label: "Receipt verification",
    description: "Inspect signed claims and run local tamper checks in real time.",
  },
  refusals: {
    number: "04",
    label: "Attack lab",
    description: "Challenge the facilitator with intentionally hostile payloads.",
  },
  evidence: {
    number: "05",
    label: "Test evidence",
    description: "Review the latest wire-level conformance artifact.",
  },
};

export default function PlaygroundHome() {
  const [config, setConfig] = useState<PlaygroundConfig | null>(null);
  const [wallet, setWallet] = useState<ClientWallet | null>(null);
  const [balance, setBalance] = useState<string>("0.00");
  const [run, setRun] = useState<RunRecord | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("flow");
  const [loading, setLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    async function init() {
      try {
        const res = await fetch("/api/config");
        if (!res.ok) throw new Error(`Failed to load config (${res.status})`);
        const cfg: PlaygroundConfig = await res.json();
        setConfig(cfg);

        // Check for existing wallet in sessionStorage
        const existing = existingWallet();
        if (existing) {
          setWallet(existing);
          const bal = await fetchNativeBalance(cfg.horizonUrl, existing.publicKey);
          setBalance(bal);
        }
      } catch (e: any) {
        setConfigError(e.message || "Failed to initialize playground.");
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  if (loading) {
    return (
      <div className="sandbox-shell flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-purple-400/25 bg-purple-500/10">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-purple-300 border-t-transparent" />
          </div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">
            Preparing protocol lab
          </p>
        </div>
      </div>
    );
  }

  if (configError || !config) {
    return (
      <div className="sandbox-shell flex min-h-screen items-center justify-center p-4">
        <div className="glass-panel w-full max-w-md space-y-3 rounded-[28px] border-rose-500/30 p-8 text-center">
          <p className="section-kicker text-rose-300">Configuration unavailable</p>
          <h2 className="text-xl font-extrabold tracking-tight text-white">The sandbox could not start</h2>
          <p className="text-sm leading-relaxed text-zinc-400">{configError}</p>
        </div>
      </div>
    );
  }

  const activeDetails = TAB_DETAILS[activeTab];

  return (
    <div className="sandbox-shell flex min-h-screen flex-col">
      <Navbar config={config} wallet={wallet} balance={balance} />

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 pb-16 pt-6 sm:px-6 sm:pt-8 lg:px-8">
        <section className="hero-surface relative overflow-hidden rounded-[30px] px-6 py-9 sm:px-9 sm:py-11 lg:rounded-[36px] lg:px-12 lg:py-14">
          <div className="purple-orb pointer-events-none absolute -right-24 -top-36 h-[420px] w-[420px] opacity-70" />
          <div className="pointer-events-none absolute right-[12%] top-1/2 hidden h-52 w-52 -translate-y-1/2 rounded-full border border-purple-300/10 lg:block" />
          <div className="pointer-events-none absolute right-[14%] top-1/2 hidden h-40 w-40 -translate-y-1/2 rounded-full border border-white/[0.06] lg:block" />

          <div className="relative grid items-end gap-10 lg:grid-cols-[minmax(0,1fr)_390px]">
            <div className="max-w-3xl">
              <div className="mb-5 flex items-center gap-3">
                <span className="flex items-center gap-2 rounded-full border border-purple-400/25 bg-purple-500/[0.08] px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-purple-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-purple-300" />
                  Live protocol environment
                </span>
                <span className="hidden font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600 sm:inline">
                  Built for Stellar
                </span>
              </div>
              <h1 className="max-w-3xl text-[2.5rem] font-extrabold leading-[0.98] tracking-[-0.055em] text-white sm:text-6xl lg:text-[4.35rem]">
                See every layer of a
                <span className="block bg-gradient-to-r from-purple-300 via-purple-400 to-fuchsia-500 bg-clip-text text-transparent">
                  Stellar payment.
                </span>
              </h1>
              <p className="mt-6 max-w-2xl text-sm leading-6 text-zinc-400 sm:text-[15px]">
                Create, sign, settle, and verify a real x402 transaction—then inspect the exact wire payload and challenge its security boundaries.
              </p>
            </div>

            <div className="grid grid-cols-3 overflow-hidden rounded-[22px] border border-white/10 bg-black/35 backdrop-blur-xl">
              <div className="border-r border-white/10 p-4 sm:p-5">
                <span className="block font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-600">Protocol</span>
                <strong className="mt-2 block text-sm font-extrabold text-white">x402 v2</strong>
              </div>
              <div className="border-r border-white/10 p-4 sm:p-5">
                <span className="block font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-600">Scheme</span>
                <strong className="mt-2 block text-sm font-extrabold text-white">Exact</strong>
              </div>
              <div className="p-4 sm:p-5">
                <span className="block font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-600">Network</span>
                <strong className="mt-2 block text-sm font-extrabold text-purple-300">Testnet</strong>
              </div>
            </div>
          </div>
        </section>

        <section className="pt-10 lg:pt-12">
          <div className="mb-5 flex items-end justify-between gap-4 px-1">
            <div>
              <p className="section-kicker">Workspace / {activeDetails.number}</p>
              <h2 className="mt-1.5 text-xl font-extrabold tracking-[-0.025em] text-white sm:text-2xl">
                {activeDetails.label}
              </h2>
              <p className="mt-1 text-xs text-zinc-500">{activeDetails.description}</p>
            </div>
            <div className="hidden items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-600 sm:flex">
              <span className="h-px w-12 bg-gradient-to-r from-transparent to-purple-500/50" />
              Interactive lab
            </div>
          </div>

          <div className="grid items-start gap-5 lg:grid-cols-[268px_minmax(0,1fr)] lg:gap-7">
            <Sidebar
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              hasRun={Boolean(run)}
            />

            <section
              key={activeTab}
              className="panel-enter min-w-0 rounded-[28px] border border-white/[0.07] bg-black/25 p-4 shadow-[0_30px_90px_rgba(0,0,0,0.24)] backdrop-blur-sm sm:p-6 lg:min-h-[720px] lg:rounded-[32px] lg:p-8"
            >
              {activeTab === "flow" && (
                <FlowPanel
                  config={config}
                  wallet={wallet}
                  setWallet={setWallet}
                  balance={balance}
                  setBalance={setBalance}
                  run={run}
                  setRun={setRun}
                />
              )}

              {activeTab === "wire" && <WirePanel config={config} run={run} />}

              {activeTab === "receipt" && (
                <ReceiptPanel config={config} wallet={wallet} run={run} />
              )}

              {activeTab === "refusals" && (
                <RefusalsPanel config={config} wallet={wallet} run={run} />
              )}

              {activeTab === "evidence" && <EvidencePanel config={config} />}
            </section>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.07] bg-black/35 px-4 py-7 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-600">
          <span>Veridex · Apache-2.0 open source</span>
          <span className="break-all normal-case tracking-normal text-zinc-700 sm:text-right">
            {config.facilitatorUrl} · {config.demoServerUrl}
          </span>
        </div>
      </footer>
    </div>
  );
}
