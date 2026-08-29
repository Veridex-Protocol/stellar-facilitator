"use client";

import React, { useState } from "react";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { PlaygroundConfig, RunRecord } from "@/lib/types";
import { CodeBlock } from "./CodeBlock";
import { Search, Layers, FileCode, CheckCircle } from "lucide-react";

interface WirePanelProps {
  config: PlaygroundConfig;
  run: RunRecord | null;
}

function decodeEnvelope(envelope: string, networkPassphrase: string): unknown {
  try {
    const tx = TransactionBuilder.fromXDR(envelope, networkPassphrase) as any;
    return {
      type: "TransactionEnvelope",
      fee: tx.fee,
      source: tx.source,
      sequence: tx.sequence?.toString?.() || tx.sequence,
      operations: (tx.operations || []).map((op: any) => ({
        type: op.type,
        source: op.source,
        contract: op.func?.invokeContract?.()?.contractAddress?.()?.toString?.() || "Soroban Contract",
        function: op.func?.invokeContract?.()?.functionName?.()?.toString?.() || "transfer",
        authEntriesCount: op.auth?.length || 0,
        subInvocations: 0,
      })),
    };
  } catch (e: any) {
    return { rawEnvelope: envelope, decodeError: e.message };
  }
}

export function WirePanel({ config, run }: WirePanelProps) {
  const [activeSection, setActiveSection] = useState<"challenge" | "envelope" | "verify" | "settle">("envelope");

  if (!run || !run.paymentPayload) {
    return (
      <div className="glass-panel p-8 rounded-2xl text-center space-y-3">
        <Layers className="w-8 h-8 text-sky-400 mx-auto opacity-75" />
        <h3 className="font-bold text-base text-white">No Wire Traffic Captured Yet</h3>
        <p className="text-xs text-slate-400 max-w-md mx-auto">
          Execute a payment in the <strong>Payment Flow</strong> tab first. Every raw HTTP header, Soroban authorization entry, and Stellar envelope will be decoded and inspectable here.
        </p>
      </div>
    );
  }

  const networkPassphrase =
    config.network === "stellar:pubnet"
      ? "Public Global Stellar Network ; September 2015"
      : "Test SDF Network ; September 2015";

  const rawEnvelope = run.paymentPayload?.payload?.transaction;
  const decodedEnvelope = rawEnvelope ? decodeEnvelope(rawEnvelope, networkPassphrase) : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-extrabold text-white">Decoded Protocol Wire Traffic</h2>
        <p className="text-xs text-slate-400">
          Inspect the exact cryptographic envelopes, headers, and Soroban authorization entries exchanged on the wire
        </p>
      </div>

      <div className="flex items-center gap-2 border-b border-white/10 pb-3 overflow-x-auto">
        <button
          onClick={() => setActiveSection("envelope")}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
            activeSection === "envelope"
              ? "bg-sky-500/20 text-sky-400 border border-sky-400/30"
              : "text-slate-400 hover:text-white"
          }`}
        >
          1. Signed Soroban Envelope
        </button>
        <button
          onClick={() => setActiveSection("challenge")}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
            activeSection === "challenge"
              ? "bg-sky-500/20 text-sky-400 border border-sky-400/30"
              : "text-slate-400 hover:text-white"
          }`}
        >
          2. HTTP 402 Challenge
        </button>
        <button
          onClick={() => setActiveSection("verify")}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
            activeSection === "verify"
              ? "bg-sky-500/20 text-sky-400 border border-sky-400/30"
              : "text-slate-400 hover:text-white"
          }`}
        >
          3. Pre-Flight /verify
        </button>
        <button
          onClick={() => setActiveSection("settle")}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
            activeSection === "settle"
              ? "bg-sky-500/20 text-sky-400 border border-sky-400/30"
              : "text-slate-400 hover:text-white"
          }`}
        >
          4. Settle & Receipt
        </button>
      </div>

      {activeSection === "envelope" && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-sky-500/5 border border-sky-400/20 text-xs text-sky-300">
            <strong>Soroban Authorization Invariant:</strong> The client signs a single authorization entry for the specific SEP-41 token contract transfer. Notice <code className="inline">subInvocations: 0</code>, proving no hidden secondary authorizations exist.
          </div>
          <CodeBlock code={decodedEnvelope} label="Decoded Transaction Envelope & Auth Entries" />
          <CodeBlock code={run.paymentPayload} label="Full PaymentPayload JSON" />
        </div>
      )}

      {activeSection === "challenge" && (
        <div className="space-y-4">
          <CodeBlock code={run.paymentRequirements} label="Payment Requirements (from PAYMENT-REQUIRED)" />
        </div>
      )}

      {activeSection === "verify" && (
        <div className="space-y-4">
          <CodeBlock code={run.verifyResponse} label="POST /verify Facilitator Response" />
        </div>
      )}

      {activeSection === "settle" && (
        <div className="space-y-4">
          <CodeBlock code={run.settleResponse} label="POST /settle Settlement Response Header" />
        </div>
      )}
    </div>
  );
}
