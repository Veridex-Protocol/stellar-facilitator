"use client";

import React, { useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import type { PlaygroundConfig } from "@/lib/types";
import { fetchWithTimeout } from "@/lib/http";
import { CodeBlock } from "./CodeBlock";

interface DiscoveryPanelProps {
  config: PlaygroundConfig;
}

export function DiscoveryPanel({ config }: DiscoveryPanelProps) {
  const [query, setQuery] = useState("demo testnet");
  const [results, setResults] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/discovery/search", config.bazaarUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("network", config.network);
      url.searchParams.set("limit", "20");
      const response = await fetchWithTimeout(url.toString(), {}, 10_000, "Bazaar search");
      const body = await response.json();
      if (!response.ok) throw new Error(body.reason || `Bazaar search failed (${response.status})`);
      setResults(Array.isArray(body.results) ? body.results : []);
      setSelected(Array.isArray(body.results) && body.results.length > 0 ? body.results[0] : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bazaar search failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 border-b border-white/[0.07] pb-6">
        <label className="min-w-[240px] flex-1">
          <span className="section-kicker mb-2 block">Catalog query</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void search()}
            className="h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-sm text-white outline-none focus:border-purple-400/50"
          />
        </label>
        <button onClick={() => void search()} disabled={loading || !query.trim()} className="primary-action flex h-11 items-center gap-2 rounded-xl px-4 text-xs font-extrabold disabled:opacity-50">
          <Search className="h-4 w-4" />
          {loading ? "Searching" : "Search Bazaar"}
        </button>
      </div>

      {error && <p className="rounded-xl border border-rose-500/25 bg-rose-500/[0.07] p-4 text-xs text-rose-200">{error}</p>}

      <div className="grid gap-5 xl:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.15fr)]">
        <div className="space-y-2">
          {results.length === 0 ? (
            <p className="py-12 text-center text-xs text-zinc-500">Run a catalog query to inspect live discovery results.</p>
          ) : results.map((resource) => (
            <button
              key={`${resource.resourceUrl}:${resource.toolName || ""}`}
              onClick={() => setSelected(resource)}
              className={`w-full border-l-2 p-4 text-left transition-colors ${selected === resource ? "border-purple-300 bg-purple-500/10" : "border-white/10 bg-white/[0.025] hover:border-white/30"}`}
            >
              <strong className="block truncate text-sm text-white">{resource.serviceName || resource.toolName || resource.resourceUrl}</strong>
              <span className="mt-1 block truncate font-mono text-[10px] text-zinc-500">{resource.resourceUrl}</span>
              <span className="mt-2 block text-[11px] text-zinc-400">{resource.scheme} · {resource.network}</span>
            </button>
          ))}
        </div>

        <div className="min-w-0 border-l border-white/[0.07] pl-0 xl:pl-6">
          {selected ? (
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="section-kicker">Selected resource</p>
                  <h3 className="mt-2 text-lg font-extrabold text-white">{selected.serviceName || selected.toolName || "Catalog resource"}</h3>
                  <p className="mt-2 text-xs leading-5 text-zinc-400">{selected.description}</p>
                </div>
                <a href={selected.resourceUrl} target="_blank" rel="noreferrer" title="Open resource" className="secondary-action rounded-xl p-2.5 text-purple-300">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
              <CodeBlock
                label="Payment and provenance fields"
                code={{
                  resource: selected.resourceUrl,
                  toolName: selected.toolName || null,
                  payTo: selected.payTo,
                  network: selected.network,
                  scheme: selected.scheme,
                  extensions: selected.extensions || {},
                  telemetry: selected.telemetry || null,
                }}
              />
            </div>
          ) : <p className="py-12 text-center text-xs text-zinc-500">Select a result to inspect its payment identity.</p>}
        </div>
      </div>
    </div>
  );
}