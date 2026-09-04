"use client";

import React, { useState } from "react";
import { Address, TransactionBuilder } from "@stellar/stellar-sdk";
import type { PlaygroundConfig, RunRecord } from "@/lib/types";
import { CodeBlock } from "./CodeBlock";
import { Layers } from "lucide-react";

interface WirePanelProps {
  config: PlaygroundConfig;
  run: RunRecord | null;
}

function countSubInvocations(invocation: any): number {
  const children = invocation?.subInvocations?.() ?? [];
  return children.reduce(
    (total: number, child: any) => total + 1 + countSubInvocations(child),
    0
  );
}

function decodeOperation(op: any) {
  const authEntries = op.auth ?? [];
  let invocation: any;

  try {
    invocation = op.func?.invokeContract?.();
  } catch {
    invocation = undefined;
  }

  return {
    type: op.type,
    source: op.source,
    contract: invocation
      ? Address.fromScAddress(invocation.contractAddress()).toString()
      : undefined,
    function: invocation?.functionName?.()?.toString?.(),
    authEntriesCount: authEntries.length,
    subInvocations: authEntries.reduce(
      (total: number, entry: any) => total + countSubInvocations(entry.rootInvocation?.()),
      0
    ),
  };
}

function decodeEnvelope(envelope: string, networkPassphrase: string): unknown {
  try {
    const tx = TransactionBuilder.fromXDR(envelope, networkPassphrase) as any;
    return {
      type: "TransactionEnvelope",
      fee: tx.fee,
      source: tx.source,
      sequence: tx.sequence?.toString?.() || tx.sequence,
      operations: (tx.operations || []).map(decodeOperation),
    };
  } catch (e: any) {
    return { rawEnvelope: envelope, decodeError: e.message };
  }
}

export function WirePanel({ config, run }: WirePanelProps) {
  const [activeSection, setActiveSection] = useState<"challenge" | "envelope" | "verify" | "settle">("envelope");

  if (!run || !run.paymentPayload) {
    return (
      <div className="glass-panel flex min-h-[420px] flex-col items-center justify-center space-y-4 rounded-[26px] p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-purple-400/25 bg-purple-500/10 text-purple-200">
          <Layers className="h-6 w-6" />
        </div>
        <div>
          <p className="section-kicker mb-2">Awaiting capture</p>
          <h3 className="text-lg font-extrabold tracking-tight text-white">No wire traffic yet</h3>
        </div>
        <p className="mx-auto max-w-md text-xs leading-relaxed text-zinc-500">
          Run a payment first. The sandbox will decode its HTTP headers, Soroban authorization, and signed Stellar envelope here.
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
        <p className="section-kicker mb-1.5">Protocol inspector</p>
        <h2 className="text-xl font-extrabold tracking-tight text-white">Decoded wire traffic</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          Inspect the cryptographic envelope, headers, and Soroban authorization exchanged on the wire.
        </p>
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto rounded-2xl border border-white/[0.07] bg-black/35 p-1.5">
        <button
          onClick={() => setActiveSection("envelope")}
          className={`whitespace-nowrap rounded-xl border px-3.5 py-2.5 text-[11px] font-bold transition-colors ${
            activeSection === "envelope"
              ? "border-white bg-white text-black"
              : "border-transparent text-zinc-500 hover:bg-purple-500/[0.08] hover:text-purple-200"
          }`}
        >
          1. Signed Soroban Envelope
        </button>
        <button
          onClick={() => setActiveSection("challenge")}
          className={`whitespace-nowrap rounded-xl border px-3.5 py-2.5 text-[11px] font-bold transition-colors ${
            activeSection === "challenge"
              ? "border-white bg-white text-black"
              : "border-transparent text-zinc-500 hover:bg-purple-500/[0.08] hover:text-purple-200"
          }`}
        >
          2. HTTP 402 Challenge
        </button>
        <button
          onClick={() => setActiveSection("verify")}
          className={`whitespace-nowrap rounded-xl border px-3.5 py-2.5 text-[11px] font-bold transition-colors ${
            activeSection === "verify"
              ? "border-white bg-white text-black"
              : "border-transparent text-zinc-500 hover:bg-purple-500/[0.08] hover:text-purple-200"
          }`}
        >
          3. Pre-Flight /verify
        </button>
        <button
          onClick={() => setActiveSection("settle")}
          className={`whitespace-nowrap rounded-xl border px-3.5 py-2.5 text-[11px] font-bold transition-colors ${
            activeSection === "settle"
              ? "border-white bg-white text-black"
              : "border-transparent text-zinc-500 hover:bg-purple-500/[0.08] hover:text-purple-200"
          }`}
        >
          4. Settle & Receipt
        </button>
      </div>

      {activeSection === "envelope" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-purple-400/20 bg-purple-500/[0.06] p-4 text-xs leading-relaxed text-purple-200">
            <strong className="text-white">Soroban authorization invariant:</strong> The client signs one authorization entry for the specified SEP-41 token transfer. Inspect <code className="inline">subInvocations: 0</code> to confirm that the captured entry has no nested authorization calls.
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
