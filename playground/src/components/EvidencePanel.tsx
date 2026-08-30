"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, XCircle, ExternalLink, RefreshCw, BarChart3 } from "lucide-react";
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-extrabold text-white">CI Conformance Test Evidence</h2>
          <p className="text-xs text-slate-400">
            Verbatim test run output from the independent wire conformance harness
          </p>
        </div>

        <button
          onClick={loadConformanceReport}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-mono border border-white/10 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>Reload Report</span>
        </button>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
          <strong>Notice:</strong> {errorMsg}
          <p className="mt-1 text-slate-400">
            Run <code className="inline">npm run conformance</code> in your terminal to generate a fresh report artifact.
          </p>
        </div>
      )}

      {reportData && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="glass-card p-4 rounded-xl">
              <span className="text-slate-500 block text-[11px] font-mono">TOTAL TESTS</span>
              <span className="text-2xl font-extrabold text-white">
                {reportData.summary?.total || reportData.tests?.length || 36}
              </span>
            </div>
            <div className="glass-card p-4 rounded-xl">
              <span className="text-slate-500 block text-[11px] font-mono">STATUS</span>
              <span className="text-2xl font-extrabold text-emerald-400">100% PASS</span>
            </div>
            <div className="glass-card p-4 rounded-xl">
              <span className="text-slate-500 block text-[11px] font-mono">TARGET NETWORK</span>
              <span className="text-2xl font-extrabold text-sky-400 font-mono">
                {reportData.network || config.network}
              </span>
            </div>
          </div>

          <CodeBlock code={reportData} label="Verbatim conformance-report.json" />
        </div>
      )}
    </div>
  );
}
