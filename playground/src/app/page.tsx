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
      <div className="min-h-screen bg-[#080c10] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
          <p className="text-xs font-mono text-slate-400">Loading Veridex Playground...</p>
        </div>
      </div>
    );
  }

  if (configError || !config) {
    return (
      <div className="min-h-screen bg-[#080c10] flex items-center justify-center p-4">
        <div className="glass-panel p-6 rounded-2xl max-w-md w-full border-rose-500/40 text-center space-y-3">
          <h2 className="text-base font-bold text-white">Playground Configuration Error</h2>
          <p className="text-xs text-rose-300">{configError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#080c10] flex flex-col">
      <Navbar config={config} wallet={wallet} balance={balance} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col lg:flex-row gap-8 items-start">
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          hasRun={Boolean(run)}
        />

        <section className="flex-1 w-full min-w-0">
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

          {activeTab === "wire" && (
            <WirePanel config={config} run={run} />
          )}

          {activeTab === "receipt" && (
            <ReceiptPanel config={config} wallet={wallet} run={run} />
          )}

          {activeTab === "refusals" && (
            <RefusalsPanel config={config} wallet={wallet} run={run} />
          )}

          {activeTab === "evidence" && (
            <EvidencePanel config={config} />
          )}
        </section>
      </main>

      <footer className="border-t border-white/10 bg-[#0f1620]/80 py-6 px-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 flex-wrap text-xs text-slate-500 font-mono">
          <span>Apache-2.0 Open Source Protocol</span>
          <span>
            Facilitator: {config.facilitatorUrl} · Resource: {config.demoServerUrl}
          </span>
        </div>
      </footer>
    </div>
  );
}
