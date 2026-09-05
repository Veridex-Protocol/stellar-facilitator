"use client";

import React from "react";
import { Zap } from "lucide-react";
import type { PlaygroundConfig, ClientWallet } from "@/lib/types";

interface NavbarProps {
  config: PlaygroundConfig | null;
  wallet: ClientWallet | null;
  balance: string;
}

export function Navbar({ config, wallet, balance }: NavbarProps) {
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.07] bg-black/70 backdrop-blur-2xl">
      <div className="mx-auto flex min-h-[72px] w-full max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3.5">
          <div className="relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl border border-purple-300/30 bg-purple-600 shadow-[0_0_28px_rgba(147,51,234,0.38)]">
            <div className="absolute inset-0 bg-gradient-to-br from-white/25 to-transparent" />
            <Zap className="relative h-[18px] w-[18px] fill-white text-white" />
          </div>
          <div className="flex items-center gap-3">
            <div>
              <div className="text-[15px] font-extrabold tracking-[-0.02em] text-white">
                Veridex
              </div>
              <div className="hidden text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 sm:block">
                Stellar protocol lab
              </div>
            </div>
            <div className="hidden h-8 w-px bg-white/10 sm:block" />
            <span className="hidden rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-300 sm:inline-flex">
              x402 sandbox
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {wallet && (
            <div className="hidden items-center gap-3 rounded-full border border-white/10 bg-white/[0.04] py-1.5 pl-2 pr-3 font-mono text-[11px] md:flex">
              <span className="flex h-6 items-center rounded-full bg-white px-2 font-bold text-black">
                {balance ? `${balance} XLM` : "Funding"}
              </span>
              <span className="text-zinc-400">
                {wallet.publicKey.slice(0, 4)}···{wallet.publicKey.slice(-4)}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 rounded-full border border-purple-400/25 bg-purple-500/[0.08] px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-purple-200">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-purple-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-purple-300" />
            </span>
            <span>{config?.network || "stellar:testnet"}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
