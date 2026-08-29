"use client";

import React, { useState } from "react";
import { Keypair } from "@stellar/stellar-sdk";
import { ShieldAlert, Play, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import type { PlaygroundConfig, ClientWallet, RunRecord } from "@/lib/types";
import { postFacilitator } from "@/lib/x402";
import { CodeBlock } from "./CodeBlock";

interface RefusalsPanelProps {
  config: PlaygroundConfig;
  wallet: ClientWallet | null;
  run: RunRecord | null;
}

interface AttackItem {
  id: string;
  title: string;
  note: string;
  expectedReason: string;
  build: (ctx: { terms: any; genuinePayload: any }) => Promise<{
    paymentPayload: any;
    paymentRequirements: any;
  }>;
}

const ATTACKS: AttackItem[] = [
  {
    id: "amount",
    title: "1. Amount Inflation Attack",
    note: "Presents a genuine signed payment against terms demanding a larger amount.",
    expectedReason: "invalid_exact_stellar_payload_wrong_amount",
    build: async ({ terms, genuinePayload }) => ({
      paymentPayload: genuinePayload,
      paymentRequirements: { ...terms, amount: String(BigInt(terms.amount || "1000") + 1000n) },
    }),
  },
  {
    id: "recipient",
    title: "2. Recipient Redirection Attack",
    note: "Attempts to redirect the payment to an attacker-controlled Stellar G-address.",
    expectedReason: "invalid_exact_stellar_payload_wrong_recipient",
    build: async ({ terms, genuinePayload }) => ({
      paymentPayload: genuinePayload,
      paymentRequirements: { ...terms, payTo: Keypair.random().publicKey() },
    }),
  },
  {
    id: "asset",
    title: "3. Counterfeit Token Contract Attack",
    note: "Substitutes an unauthorized SEP-41 token contract identifier.",
    expectedReason: "invalid_exact_stellar_payload_wrong_asset",
    build: async ({ terms, genuinePayload }) => ({
      paymentPayload: genuinePayload,
      paymentRequirements: {
        ...terms,
        asset: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    }),
  },
  {
    id: "fee_drain",
    title: "4. Facilitator Fee Drain Attack (VDX-06)",
    note: "Requests 10 XLM fee sponsorship, exceeding the spec ceiling of 50,000 stroops.",
    expectedReason: "invalid_exact_stellar_payload_fee_exceeds_maximum",
    build: async ({ terms, genuinePayload }) => ({
      paymentPayload: {
        ...genuinePayload,
        payload: { ...genuinePayload.payload, maxFee: "100000000" },
      },
      paymentRequirements: terms,
    }),
  },
  {
    id: "malformed",
    title: "5. Malformed Envelope Injection",
    note: "Submits corrupted base64 XDR bytes to test cryptographic parser isolation.",
    expectedReason: "invalid_exact_stellar_payload_malformed_envelope",
    build: async ({ terms, genuinePayload }) => ({
      paymentPayload: {
        ...genuinePayload,
        payload: { ...genuinePayload.payload, transaction: "AAAA_CORRUPT_ENVELOPE_DATA_XXXX" },
      },
      paymentRequirements: terms,
    }),
  },
];

export function RefusalsPanel({ config, wallet, run }: RefusalsPanelProps) {
  const [results, setResults] = useState<Record<string, { body: any; status: number; loading?: boolean }>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const executeAttack = async (attack: AttackItem) => {
    if (!run?.paymentPayload || !run?.paymentRequirements) {
      setErrorMsg("Run a payment in the Payment Flow tab first to generate signed baseline fixtures.");
      return;
    }

    setErrorMsg(null);
    setResults((prev) => ({ ...prev, [attack.id]: { body: null, status: 0, loading: true } }));

    try {
      const probeData = await attack.build({
        terms: run.paymentRequirements,
        genuinePayload: run.paymentPayload,
      });

      const { body, status } = await postFacilitator(config, "/verify", probeData);
      setResults((prev) => ({
        ...prev,
        [attack.id]: { body, status, loading: false },
      }));
    } catch (e: any) {
      setResults((prev) => ({
        ...prev,
        [attack.id]: { body: { error: e.message }, status: 500, loading: false },
      }));
    }
  };

  const runAllProbes = async () => {
    for (const attack of ATTACKS) {
      await executeAttack(attack);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-extrabold text-white">
            Security Refusals & Attack Probes (Chaos Sandbox)
          </h2>
          <p className="text-xs text-slate-400">
            Probe malformed transactions directly against <code className="inline">POST /verify</code>. All rejections return deterministic reason codes with zero fee spend.
          </p>
        </div>

        <button
          onClick={runAllProbes}
          className="px-4 py-2 rounded-xl bg-gradient-to-r from-rose-500 to-pink-600 hover:from-rose-400 hover:to-pink-500 text-white font-bold text-xs shadow-md transition-all"
        >
          Run All 5 Probes
        </button>
      </div>

      {errorMsg && (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
          {errorMsg}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {ATTACKS.map((attack) => {
          const res = results[attack.id];
          const hasResult = res && !res.loading;
          const isRefused = hasResult && res.body?.isValid === false;

          return (
            <div
              key={attack.id}
              className="glass-card p-5 rounded-2xl flex flex-col justify-between gap-3"
            >
              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <h3 className="font-bold text-sm text-white">{attack.title}</h3>
                  {hasResult && isRefused && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold">
                      Refused (Protected)
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 leading-relaxed mb-3">{attack.note}</p>

                <div className="p-2 rounded-lg bg-black/40 border border-white/5 font-mono text-[11px] text-sky-300 mb-3">
                  Expected Code: {attack.expectedReason}
                </div>
              </div>

              <div>
                <button
                  onClick={() => executeAttack(attack)}
                  disabled={res?.loading}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-200 text-xs font-mono font-bold border border-white/10 transition-colors disabled:opacity-50"
                >
                  {res?.loading ? (
                    "Probing /verify..."
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 fill-current text-rose-400" />
                      <span>Launch Attack Probe</span>
                    </>
                  )}
                </button>

                {hasResult && (
                  <div className="mt-3">
                    <CodeBlock code={res.body} label="Facilitator Refusal Response" />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
