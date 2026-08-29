"use client";

import React from "react";
import { Zap, ShieldCheck } from "lucide-react";
import type { PlaygroundConfig, ClientWallet } from "@/lib/types";

interface NavbarProps {
  config: PlaygroundConfig | null;
  wallet: ClientWallet | null;
  balance: string;
}

export function Navbar({ config, wallet, balance }: NavbarProps) {
  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#0f1620]/85 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="relative w-9 h-9 rounded-xl bg-gradient-to-br from-sky-500/30 to-indigo-500/30 border border-sky-400/40 flex items-center justify-center shadow-[0_0_16px_rgba(56,189,248,0.25)]">
            <Zap className="w-5 h-5 text-sky-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-base tracking-tight text-white">
                Veridex
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full font-bold bg-gradient-to-r from-sky-400 to-indigo-400 text-slate-950">
                x402 Sandbox
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">
              Stellar testnet payment & cryptographic proof inspector
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {wallet && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/10 bg-slate-900/60 font-mono text-xs text-slate-300">
              <span className="text-emerald-400">●</span>
              <span>{balance ? `${balance} XLM` : "Funding..."}</span>
              <span className="text-slate-500">|</span>
              <span className="text-slate-400">
                {wallet.publicKey.slice(0, 4)}...{wallet.publicKey.slice(-4)}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 px-3 py-1 rounded-full border border-sky-400/30 bg-sky-500/10 font-mono text-xs text-sky-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse-beacon" />
            <span>{config?.network || "stellar:testnet"}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
