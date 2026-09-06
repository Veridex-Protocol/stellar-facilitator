"use client";

import React, { useEffect, useState } from "react";
import { ExternalLink, FileCheck2, RefreshCw } from "lucide-react";
import type { PlaygroundConfig } from "@/lib/types";
import { CodeBlock } from "./CodeBlock";

interface EvidencePanelProps {
  config: PlaygroundConfig;
}

export function EvidencePanel({ config }: EvidencePanelProps) {
  const [reportData, setReportData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadConformanceReport = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/conformance");
      const data = await res.json();
      if (!res.ok || !data.available) {
        throw new Error(data.reason || "Conformance report unavailable on disk.");
      }
      setReportData(data.report);
    } catch (e: any) {
      setErrorMsg(e.message || "Failed to load conformance evidence report.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConformanceReport();
  }, []);

  const passed = Number(reportData?.passed ?? 0);
  const failed = Number(reportData?.failed ?? 0);
  const total = passed + failed;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="section-kicker mb-1.5">Run artifact</p>
          <h2 className="text-xl font-extrabold tracking-tight text-white">Conformance evidence</h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Inspect the latest conformance report available to this playground instance.
          </p>
        </div>

        <button
          onClick={loadConformanceReport}
          disabled={loading}
          className="secondary-action inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2.5 font-mono text-[10px]"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>{loading ? "Loading…" : "Reload report"}</span>
        </button>
      </div>

      {errorMsg && (
        <div className="glass-panel flex min-h-[340px] flex-col items-center justify-center rounded-[26px] border-amber-500/20 p-8 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-400/20 bg-amber-500/[0.07] text-amber-200">
            <FileCheck2 className="h-6 w-6" />
          </div>
          <p className="section-kicker mb-2">Artifact unavailable</p>
          <h3 className="text-sm font-extrabold text-white">{errorMsg}</h3>
          <p className="mt-2 max-w-md text-xs leading-relaxed text-zinc-500">
            Run <code className="inline">npm run conformance</code> at the repository root, then reload this view.
          </p>
        </div>
      )}

      {loading && !reportData && (
        <div className="glass-panel flex min-h-[340px] items-center justify-center rounded-[26px]">
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-purple-400/20 bg-purple-500/[0.07] text-purple-200">
              <RefreshCw className="h-5 w-5 animate-spin" />
            </div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">Loading run artifact</p>
          </div>
        </div>
      )}

      {reportData && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="glass-card rounded-[20px] p-5">
              <span className="block font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">Total checks</span>
              <span className="mt-2 block text-2xl font-black text-white">{total}</span>
            </div>
            <div className="glass-card rounded-[20px] p-5">
              <span className="block font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">Result</span>
              <span className={`mt-2 block text-2xl font-black ${failed === 0 && total > 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {passed} passed · {failed} failed
              </span>
            </div>
            <div className="glass-card rounded-[20px] p-5">
              <span className="block font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">Target network</span>
              <span className="mt-2 block break-all font-mono text-base font-extrabold text-purple-200">
                {reportData.network || config.network}
              </span>
            </div>
          </div>

          <div className="border-y border-white/[0.08] py-5">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="section-kicker">Recorded testnet transactions</p>
                <p className="mt-1 text-xs text-zinc-500">Run {reportData.runAt || "timestamp unavailable"} · not generated by this page load</p>
              </div>
              <span className="font-mono text-[10px] text-amber-300">upto: experimental · unaudited</span>
            </div>
            <div className="grid gap-px overflow-hidden border border-white/[0.08] bg-white/[0.08] md:grid-cols-3">
              {[
                ["Exact", reportData.settledTransaction],
                ["Upto partial", reportData.uptoPartialTransaction],
                ["Upto zero", reportData.uptoZeroTransaction],
              ].map(([label, hash]) => (
                <div key={String(label)} className="min-w-0 bg-black/55 p-4">
                  <span className="section-kicker">{label}</span>
                  <p className="mt-2 truncate font-mono text-[10px] text-zinc-400">{hash || "not recorded"}</p>
                  {hash && (
                    <a href={`${config.explorerTxUrl}/${hash}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-purple-300">
                      Open proof <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="border-l-2 border-emerald-400 bg-emerald-400/[0.04] p-4">
            <strong className="text-sm text-white">MCP signing boundary</strong>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              `pay_resource` returns a bounded challenge and accepts only an externally signed payload. The MCP process holds no buyer private key; its current proof is deterministic until the keyless flow is rerun live.
            </p>
          </div>

          <CodeBlock code={reportData} label="Verbatim conformance-report.json" />
        </div>
      )}
    </div>
  );
}
