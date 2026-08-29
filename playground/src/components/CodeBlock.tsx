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
    <div className="my-3 rounded-lg overflow-hidden border border-white/10 bg-[#090d13] shadow-md">
      <div className="flex items-center justify-between px-3.5 py-2 bg-[#111721] border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#27c93f]" />
          {label && (
            <span className="ml-2 font-mono text-xs font-medium text-slate-400">
              {label}
            </span>
          )}
        </div>
        <button
          onClick={handleCopy}
          type="button"
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-mono rounded bg-white/5 hover:bg-white/10 text-slate-300 transition-colors"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3 text-slate-400" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-4 m-0 font-mono text-xs text-slate-200 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed max-h-[420px] overflow-y-auto">
        {text}
      </pre>
    </div>
  );
}
