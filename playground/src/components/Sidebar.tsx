"use client";

import React from "react";
import { Zap, Search, FileCheck, ShieldAlert, BarChart3, Lock, ExternalLink, ListFilter, ShieldCheck, Network } from "lucide-react";

export type TabId = "gateway" | "flow" | "discovery" | "policy" | "wire" | "receipt" | "refusals" | "evidence";

interface TabItem {
  id: TabId;
  number: string;
  label: string;
  blurb: string;
  icon: React.ReactNode;
  badge?: string;
}

const TABS: TabItem[] = [
  {
    id: "gateway",
    number: "01",
    label: "API Gateway",
    blurb: "Put x402 before an existing API",
    icon: <Network className="h-4 w-4" />,
    badge: "New",
  },
  {
    id: "flow",
    number: "02",
    label: "Payment Flow",
    blurb: "Settle a live payment on Stellar",
    icon: <Zap className="h-4 w-4" />,
  },
  {
    id: "discovery",
    number: "03",
    label: "Bazaar Discovery",
    blurb: "Search and inspect payment identity",
    icon: <ListFilter className="h-4 w-4" />,
  },
  {
    id: "policy",
    number: "04",
    label: "Agent Policy",
    blurb: "Approve or block before signing",
    icon: <ShieldCheck className="h-4 w-4" />,
  },
  {
    id: "wire",
    number: "05",
    label: "Wire Protocol",
    blurb: "Decode HTTP and Soroban auth",
    icon: <Search className="h-4 w-4" />,
  },
  {
    id: "receipt",
    number: "06",
    label: "Receipt & Verify",
    blurb: "Inspect signatures and tampering",
    icon: <FileCheck className="h-4 w-4" />,
  },
  {
    id: "refusals",
    number: "07",
    label: "Attack Lab",
    blurb: "Probe deterministic refusals",
    icon: <ShieldAlert className="h-4 w-4" />,
    badge: "Chaos",
  },
  {
    id: "evidence",
    number: "08",
    label: "Test Evidence",
    blurb: "Read the conformance report",
    icon: <BarChart3 className="h-4 w-4" />,
  },
];

interface SidebarProps {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  hasRun: boolean;
}

export function Sidebar({ activeTab, setActiveTab, hasRun }: SidebarProps) {
  return (
    <aside className="flex w-full min-w-0 flex-col gap-4 lg:sticky lg:top-24">
      <div className="rounded-[26px] border border-white/[0.08] bg-black/55 p-2 shadow-[0_24px_70px_rgba(0,0,0,0.32)] backdrop-blur-xl">
        <div className="flex items-center justify-between px-3 pb-3 pt-2">
          <div>
            <p className="section-kicker">Explore</p>
            <p className="mt-1 text-xs text-zinc-500">Protocol inspection suite</p>
          </div>
          <span className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10px] text-zinc-500">
            8 modules
          </span>
        </div>

        <nav className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
          {TABS.map((tab) => {
            const active = activeTab === tab.id;
            const locked = tab.id !== "gateway" && tab.id !== "flow" && tab.id !== "discovery" && tab.id !== "policy" && tab.id !== "evidence" && !hasRun;

            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                aria-current={active ? "page" : undefined}
                className={`group min-w-[218px] rounded-[18px] border p-3.5 text-left transition-all duration-200 lg:min-w-0 ${
                  active
                    ? "border-white bg-white text-black shadow-[0_12px_35px_rgba(255,255,255,0.08)]"
                    : "border-transparent bg-white/[0.025] text-white hover:border-purple-400/25 hover:bg-purple-500/[0.07]"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-xl border transition-colors ${
                      active
                        ? "border-purple-500/20 bg-purple-600 text-white"
                        : "border-white/10 bg-white/[0.04] text-purple-300 group-hover:border-purple-400/30"
                    }`}
                  >
                    {tab.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-extrabold tracking-[-0.01em]">
                        {tab.label}
                      </span>
                      <span className={`font-mono text-[9px] ${active ? "text-zinc-400" : "text-zinc-600"}`}>
                        {tab.number}
                      </span>
                    </div>
                    <p className={`mt-1 truncate text-[11px] ${active ? "text-zinc-500" : "text-zinc-500"}`}>
                      {tab.blurb}
                    </p>
                    <div className="mt-2 flex min-h-4 items-center gap-2">
                      {tab.badge && (
                        <span className={`rounded-full px-2 py-0.5 text-[8px] font-black uppercase tracking-[0.14em] ${active ? "bg-black text-white" : "bg-rose-500/10 text-rose-300"}`}>
                          {tab.badge}
                        </span>
                      )}
                      {locked && (
                        <span className={`font-mono text-[9px] font-bold uppercase tracking-[0.08em] ${active ? "text-purple-700" : "text-purple-300"}`}>
                          Run payment to unlock
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="relative hidden overflow-hidden rounded-[24px] border border-purple-400/20 bg-purple-950/20 p-5 lg:block">
        <div className="purple-orb absolute -right-10 -top-12 h-32 w-32 opacity-50" />
        <div className="relative">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl border border-purple-300/20 bg-purple-500/10 text-purple-200">
            <Lock className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-bold text-white">Client-side by design</h3>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
            The ephemeral Ed25519 key stays in this browser session. No private key reaches the server.
          </p>
        </div>
      </div>

      <div className="hidden flex-col gap-1 px-2 lg:flex">
        <a
          href="https://docs.veridex.network"
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-between rounded-lg px-2 py-2 text-[11px] text-zinc-500 transition-colors hover:bg-white/[0.03] hover:text-purple-200"
        >
          <span>Developer guides</span>
          <ExternalLink className="h-3 w-3" />
        </a>
        <a
          href="https://github.com/Veridex-Protocol/stellar"
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-between rounded-lg px-2 py-2 text-[11px] text-zinc-500 transition-colors hover:bg-white/[0.03] hover:text-purple-200"
        >
          <span>GitHub repository</span>
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </aside>
  );
}
