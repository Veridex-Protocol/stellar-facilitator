import { Keypair } from "@stellar/stellar-sdk";
import type { ClientWallet } from "./types";

const WALLET_STORAGE_KEY = "veridex_playground_wallet_v2";

export function existingWallet(): ClientWallet | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(WALLET_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.publicKey && parsed.secretKey) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

export function createWallet(): ClientWallet {
  const kp = Keypair.random();
  const wallet: ClientWallet = {
    publicKey: kp.publicKey(),
    secretKey: kp.secret(),
  };
  if (typeof window !== "undefined") {
    sessionStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(wallet));
  }
  return wallet;
}

export function forgetWallet(): void {
  if (typeof window !== "undefined") {
    sessionStorage.removeItem(WALLET_STORAGE_KEY);
  }
}

export async function fundFromFriendbot(
  friendbotUrl: string,
  publicKey: string
): Promise<void> {
  const url = `${friendbotUrl}?addr=${encodeURIComponent(publicKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Friendbot funding failed (${res.status}): ${text}`);
  }
}

export async function fetchNativeBalance(
  horizonUrl: string,
  publicKey: string
): Promise<string> {
  try {
    const res = await fetch(`${horizonUrl}/accounts/${publicKey}`);
    if (res.status === 404) return "0.0000000";
    if (!res.ok) throw new Error(`Horizon account lookup failed (${res.status})`);
    const data = await res.json();
    const native = data.balances?.find((b: any) => b.asset_type === "native");
    return native ? parseFloat(native.balance).toFixed(2) : "0.00";
  } catch {
    return "0.00";
  }
}

export async function waitForRpcVisibility(
  rpcUrl: string,
  publicKey: string,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccount",
          params: { address: publicKey },
        }),
      });
      if (res.ok) {
        const body = await res.json();
        if (body.result?.sequence) return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 600));
  }
}
