"use client";

import React, { useState } from "react";
import { Keypair, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { Play } from "lucide-react";
import type { PlaygroundConfig, ClientWallet, RunRecord } from "@/lib/types";
import { postFacilitator, signPayload } from "@/lib/x402";
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

function inflateAuthorizationEntries(genuinePayload: any, network: string): any {
  const passphrase =
    network === "stellar:pubnet"
      ? "Public Global Stellar Network ; September 2015"
      : "Test SDF Network ; September 2015";
  const transaction = TransactionBuilder.fromXDR(
    genuinePayload.payload.transaction,
    passphrase
  ) as any;
  const invokeOperation = transaction.tx
    .operations()[0]
    .body()
    .invokeHostFunctionOp();
  const [authorization] = invokeOperation.auth();

  invokeOperation.auth(Array.from({ length: 20 }, () => authorization));

  return {
    ...genuinePayload,
    payload: { ...genuinePayload.payload, transaction: transaction.toXDR() },
  };
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
    note: "Substitutes a valid but unauthorized SEP-41 contract address.",
    expectedReason: "invalid_exact_stellar_payload_wrong_asset",
    build: async ({ terms, genuinePayload }) => ({
      paymentPayload: genuinePayload,
      paymentRequirements: {
        ...terms,
        asset: StrKey.encodeContract(Buffer.alloc(32, 1)),
      },
    }),
  },
  {
    id: "fee_drain",
    title: "4. Facilitator Fee Drain Attack (VDX-06)",
    note: "Bloats the envelope with duplicated authorization entries to exceed the configured simulation-derived fee ceiling.",
    expectedReason: "invalid_exact_stellar_payload_fee_exceeds_maximum",
    build: async ({ terms, genuinePayload }) => ({
      paymentPayload: inflateAuthorizationEntries(genuinePayload, terms.network),
      paymentRequirements: terms,
    }),
  },
  {
    id: "malformed",
    title: "5. Malformed Envelope Injection",
    note: "Submits corrupted base64 XDR bytes to test cryptographic parser isolation.",
    expectedReason: "invalid_exact_stellar_payload_malformed",
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
  const [isRunningAll, setIsRunningAll] = useState(false);

  const executeAttack = async (attack: AttackItem) => {
    if (!wallet || !run?.paymentRequirements) {
      setErrorMsg("Run a payment in the Payment Flow tab first to generate fresh signed fixtures.");
      return;
    }

    setErrorMsg(null);
    setResults((prev) => ({ ...prev, [attack.id]: { body: null, status: 0, loading: true } }));

    try {
      const genuinePayload = await signPayload(
        wallet,
        config.network,
        run.paymentRequirements
      );
      const probeData = await attack.build({
        terms: run.paymentRequirements,
        genuinePayload,
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
    setIsRunningAll(true);
    try {
      for (const attack of ATTACKS) {
        await executeAttack(attack);
      }
    } finally {
      setIsRunningAll(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="section-kicker mb-1.5">Adversarial laboratory</p>
          <h2 className="text-xl font-extrabold tracking-tight text-white">
            Refusal probes
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Submit altered fixtures to <code className="inline">POST /verify</code> and inspect the facilitator&apos;s exact response.
          </p>
        </div>

        <button
          onClick={runAllProbes}
          disabled={isRunningAll}
          className="primary-action inline-flex min-w-[150px] items-center justify-center rounded-xl px-4 py-3 text-[11px] font-extrabold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isRunningAll ? "Running probes…" : "Run all five probes"}
        </button>
      </div>

      {errorMsg && (
        <div className="rounded-2xl border border-rose-500/25 bg-rose-500/[0.07] p-4 text-xs text-rose-200">
          {errorMsg}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        {ATTACKS.map((attack) => {
          const res = results[attack.id];
          const hasResult = Boolean(res && !res.loading);
          const isRefused = hasResult && res.body?.isValid === false;
          const actualReason = hasResult ? res.body?.invalidReason : undefined;
          const reasonMatches = isRefused && actualReason === attack.expectedReason;

          return (
            <div
              key={attack.id}
              className="glass-card flex min-h-[240px] flex-col justify-between gap-4 rounded-[22px] p-5"
            >
              <div>
                <div className="mb-2 flex items-start justify-between gap-3">
                  <h3 className="text-sm font-extrabold leading-snug text-white">{attack.title}</h3>
                  {hasResult && (
                    <span
                      className={`shrink-0 rounded-full border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider ${
                        reasonMatches
                          ? "border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-300"
                          : "border-rose-500/20 bg-rose-500/[0.08] text-rose-300"
                      }`}
                    >
                      {reasonMatches
                        ? "Exact refusal"
                        : isRefused
                          ? "Reason mismatch"
                          : "Not refused"}
                    </span>
                  )}
                </div>
                <p className="mb-4 text-xs leading-relaxed text-zinc-500">{attack.note}</p>

                <div className="mb-3 space-y-1 overflow-x-auto rounded-xl border border-purple-400/15 bg-purple-500/[0.05] p-3 font-mono text-[9px] leading-relaxed text-purple-200">
                  <div>
                    <span className="mr-1 text-zinc-600">Expected</span> {attack.expectedReason}
                  </div>
                  {hasResult && (
                    <div className={reasonMatches ? "text-emerald-300" : "text-rose-300"}>
                      <span className="mr-1 text-zinc-600">Observed</span> {actualReason ?? "accepted or unavailable"}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <button
                  onClick={() => executeAttack(attack)}
                  disabled={isRunningAll || res?.loading}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.035] py-2.5 font-mono text-[10px] font-bold text-zinc-300 transition-colors hover:border-purple-400/25 hover:bg-purple-500/[0.07] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {res?.loading ? (
                    "Probing /verify..."
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5 fill-current text-purple-300" />
                      <span>Run refusal probe</span>
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
