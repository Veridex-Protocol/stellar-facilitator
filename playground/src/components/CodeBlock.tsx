"use client";

import React, { useState } from "react";
import { Check, Copy } from "lucide-react";

interface CodeBlockProps {
  code: unknown;
  label?: string;
}

export function CodeBlock({ code, label }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const text =
    typeof code === "string"
      ? code
      : JSON.stringify(code, null, 2) || String(code);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#050506] shadow-[0_18px_50px_rgba(0,0,0,0.22)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] bg-white/[0.025] px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full bg-white/20" />
          <span className="h-2 w-2 shrink-0 rounded-full bg-purple-400/45" />
          <span className="h-2 w-2 shrink-0 rounded-full bg-purple-400" />
          {label && (
            <span className="ml-2 truncate font-mono text-[10px] font-medium text-zinc-500">
              {label}
            </span>
          )}
        </div>
        <button
          onClick={handleCopy}
          type="button"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.035] px-2.5 py-1.5 font-mono text-[9px] text-zinc-400 transition-colors hover:border-purple-400/25 hover:text-white"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3 text-purple-300" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="m-0 max-h-[440px] overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-[10px] leading-[1.75] text-zinc-300 sm:text-[11px]">
        {text}
      </pre>
    </div>
  );
}
