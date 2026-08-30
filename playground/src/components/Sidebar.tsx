"use client";

import React from "react";
import { Zap, Search, FileCheck, ShieldAlert, BarChart3, Lock, ExternalLink } from "lucide-react";

export type TabId = "flow" | "wire" | "receipt" | "refusals" | "evidence";

interface TabItem {
  id: TabId;
  label: string;
  blurb: string;
  icon: React.ReactNode;
  badge?: string;
}

const TABS: TabItem[] = [
  {
    id: "flow",
    label: "Payment Flow",
    blurb: "Settle a live payment on Stellar in ~20s",
    icon: <Zap className="w-4 h-4 text-sky-400" />,
  },
  {
    id: "wire",
    label: "Wire Protocol",
    blurb: "Decoded HTTP & Soroban auth entries",
    icon: <Search className="w-4 h-4 text-indigo-400" />,
  },
  {
    id: "receipt",
    label: "Receipt & Verify",
    blurb: "RFC 8785 signature verification & tamper test",
    icon: <FileCheck className="w-4 h-4 text-emerald-400" />,
  },
  {
    id: "refusals",
    label: "Refusals & Attacks",
    blurb: "Probe 9 attack vectors against /verify",
    icon: <ShieldAlert className="w-4 h-4 text-rose-400" />,
    badge: "Chaos",
  },
  {
    id: "evidence",
    label: "CI Evidence",
    blurb: "Real-time conformance test report",
    icon: <BarChart3 className="w-4 h-4 text-amber-400" />,
  },
];

interface SidebarProps {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  hasRun: boolean;
}

export function Sidebar({ activeTab, setActiveTab, hasRun }: SidebarProps) {
  return (
    <aside className="w-full lg:w-72 flex-shrink-0 flex flex-col gap-5">
      <nav className="flex flex-col gap-1.5">
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full text-left p-3 rounded-xl border transition-all ${
                active
                  ? "bg-gradient-to-r from-sky-500/15 to-slate-900 border-sky-400/40 shadow-lg shadow-sky-500/10 text-white"
                  : "bg-slate-900/40 border-white/5 text-slate-300 hover:bg-slate-900 hover:border-white/15"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="p-1 rounded-lg bg-white/5 border border-white/10">
                    {tab.icon}
                  </div>
                  <span className="font-bold text-sm text-white tracking-tight">
                    {tab.label}
                  </span>
                </div>
                {tab.badge && (
                  <span className="text-[10px] uppercase tracking-wider font-extrabold px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30">
                    {tab.badge}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-1.5 line-clamp-1">{tab.blurb}</p>
              {tab.id !== "flow" && tab.id !== "evidence" && !hasRun && (
                <span className="inline-block mt-1.5 text-[10px] uppercase font-bold tracking-wider text-amber-400">
                  ⚡ needs 1 payment run
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-4 rounded-xl border border-white/10 bg-slate-900/50 backdrop-blur-sm">
        <div className="flex items-center gap-2 mb-2 font-bold text-xs text-slate-200">
          <Lock className="w-3.5 h-3.5 text-sky-400" />
          <span>In-Browser Client Key</span>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          Your Ed25519 keypair is generated directly in your browser's sessionStorage.
          The server holds no private keys and never custodies funds.
        </p>
      </div>

      <div className="flex flex-col gap-2 px-1">
        <a
          href="https://docs.veridex.network"
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-between text-xs text-slate-400 hover:text-sky-400 transition-colors py-1"
        >
          <span>Developer Guides & Specs</span>
          <ExternalLink className="w-3 h-3" />
        </a>
        <a
          href="https://github.com/Veridex-Protocol/stellar"
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-between text-xs text-slate-400 hover:text-sky-400 transition-colors py-1"
        >
          <span>GitHub Monorepo</span>
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </aside>
  );
}
